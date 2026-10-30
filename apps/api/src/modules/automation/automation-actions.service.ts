import { Injectable } from '@nestjs/common';
import type {
  AutomationEventKind,
  AutomationMessageKind,
  NotificationChannel,
  Prisma,
} from '@prisma/client';
import {
  AUTOMATION_CHANNELS,
  AUTOMATION_EMPLOYEE_CHANNELS,
  renderAutomationTemplate,
  TASK_DESCRIPTION_MAX,
  TASK_TITLE_MAX,
  type AutomationActionTypeValue,
  type AutomationClientMessageAction,
  type AutomationCreateTaskAction,
  type AutomationEmployeeNotificationAction,
  type AutomationSkipReason,
  type AutomationVariableKey,
} from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import {
  NotificationsService,
  type ChannelStep,
  type NotificationLogMeta,
  type ResolvedChannel,
} from '../notifications/notifications.service';
import { TelegramRecipientsService } from '../notifications/telegram-recipients.service';
import { TasksService, OPEN_TASK_STATUSES } from '../tasks/tasks.service';
import { AutomationContextService, type DocumentContext } from './automation-context.service';
import { quietHoursDelayMs } from './automation-text';

export type ActionStatus = 'DONE' | 'SKIPPED' | 'FAILED';

/** Результат однієї дії в `AutomationRun.actionResults` (BR-AUT-005, 050). */
export interface ActionResult {
  index: number;
  type: AutomationActionTypeValue;
  status: ActionStatus;
  reason?: AutomationSkipReason;
  error?: string;
  /** Канали поставленого в чергу ланцюжка. */
  channels?: string[];
  /** Повідомлення відкладено тихими годинами до цієї миті (BR-AUT-013). */
  delayedUntil?: string;
  /** Скільком працівникам пішло сповіщення. */
  recipients?: number;
  taskId?: string;
}

export type Vars = Partial<Record<AutomationVariableKey, string>>;

/** Що знає дія про своє спрацювання. */
export interface ActionRun {
  orgId: string;
  rule: { id: string; messageKind: AutomationMessageKind };
  ctx: DocumentContext;
  vars: Vars;
  /** Ініціатор зміни (BR-AUT-023); null — система. */
  actorId: string | null;
  occurredAt: Date;
  /** Подія правила — у `meta` job-а: «створено» оплати сторно скасовує до відправки (BR-AUT-016). */
  eventKind?: AutomationEventKind;
  now: Date;
  /**
   * «Надіслати тест» (BR-AUT-051): одержувач — той, хто тестує (телефон, email, chat id його
   * підписки на бот); без згоди й тихих годин.
   */
  test?: { phone: string | null; email: string | null; telegramChatId: string | null };
}

const EMAIL: NotificationChannel = 'EMAIL';
const TELEGRAM_BOT: NotificationChannel = 'TELEGRAM_BOT';
const HOUR_MS = 3_600_000;
const MAX_RECIPIENTS = 500;

type Template = { subject?: string | undefined; body: string };

/** Адреси одержувача за каналами: телефон, email, chat id підписки на бот (BR-AUT-041). */
interface Contact {
  phone: string | null;
  email: string | null;
  chatId: string | null;
}

/** Обрізає текст до `max` символів з «…» у кінці (поле задачі з лімітом схеми). */
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** Канали філії за набором каналів — один запит на дію, а не на кожного працівника. */
type ChannelCache = Map<string, Promise<ResolvedChannel[]>>;

/** Канали дії: явний перелік правила або «як у філії» серед дозволених для дії (BR-AUT-011). */
interface ChannelChoice {
  wanted: readonly NotificationChannel[] | undefined;
  allowed: readonly NotificationChannel[];
  /**
   * Бажаний канал клієнта (`Counterparty.preferredChannel`): у режимі «як у філії» — першим, якщо
   * доступний; явний перелік правила його не змінює. Працівникам і тесту — не передається.
   */
  preferred?: NotificationChannel | null;
}

/**
 * BR-AUT-011, бажаний канал клієнта: якщо він серед ДОСТУПНИХ каналів (налаштований у філії, з
 * адресою одержувача; бот — лише підписаному) — іде першим, решта — за пріоритетом філії без
 * повтору. Недоступний чи не заданий — порядок філії без змін (без «пропущено»).
 */
const preferredFirst = (
  channels: ResolvedChannel[],
  preferred: NotificationChannel | null | undefined,
): ResolvedChannel[] => {
  const i = preferred ? channels.findIndex(r => r.channel === preferred) : -1;
  const first = channels[i];
  return i <= 0 || !first ? channels : [first, ...channels.filter((_, j) => j !== i)];
};

/** Канал рядка «пропущено» в журналі: перший канал правила, без нього — SMS. */
const firstChannel = (wanted: readonly NotificationChannel[] | undefined): NotificationChannel =>
  wanted?.[0] ?? 'SMS';

/**
 * Три дії правила (docs/objects/automation.md, BR-AUT-010…032). Кожна повертає результат або
 * кидає — двигун ловить помилку кожної дії окремо (BR-AUT-005). Зовнішні відправки — лише через
 * чергу `sms` з повторами (BR-AUT-015).
 */
@Injectable()
export class AutomationActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly tasks: TasksService,
    private readonly context: AutomationContextService,
    private readonly telegram: TelegramRecipientsService,
  ) {}

  // ─── Повідомлення клієнту ─────────────────────────────────────────────────────────────────

  async clientMessage(
    index: number,
    action: AutomationClientMessageAction,
    run: ActionRun,
  ): Promise<ActionResult> {
    const base = { index, type: action.type };
    const { ctx } = run;
    const client = ctx.client;
    const meta: NotificationLogMeta = {
      ruleId: run.rule.id,
      documentType: ctx.documentType,
      documentId: ctx.documentId,
      eventKind: run.eventKind,
      counterpartyId: client?.counterpartyId ?? undefined,
      isTest: !!run.test,
    };
    const phone = run.test ? run.test.phone : (client?.phone ?? null);
    const email = run.test ? run.test.email : (client?.email ?? null);
    const skip = async (reason: AutomationSkipReason): Promise<ActionResult> => {
      await this.logSkipped(run, firstChannel(action.channels), phone ?? email ?? '', reason, meta);
      return { ...base, status: 'SKIPPED', reason };
    };

    if (!run.test) {
      // BR-AUT-012: службове — не тому, хто відмовився; маркетинг — лише за згодою.
      if (!client) return skip('NO_CONTACT');
      if (run.rule.messageKind === 'SERVICE' && client.noServiceMessages)
        return skip('NO_SERVICE_MESSAGES');
      if (run.rule.messageKind === 'MARKETING' && !client.marketingConsent)
        return skip('NO_MARKETING_CONSENT');
    }

    // BR-AUT-041: Telegram-бот — лише підписаному клієнту (chat id його активної підписки).
    const counterpartyId = client?.counterpartyId ?? null;
    const chatId = run.test
      ? run.test.telegramChatId
      : counterpartyId
        ? ((await this.telegram.chatIds(run.orgId, 'counterparty', [counterpartyId])).get(
            counterpartyId,
          ) ?? null)
        : null;
    const built = await this.buildChain(
      run,
      {
        wanted: action.channels,
        allowed: AUTOMATION_CHANNELS,
        // BR-AUT-011: тест іде тому, хто тестує, — бажаний канал клієнта його не стосується.
        preferred: run.test ? null : (client?.preferredChannel ?? null),
      },
      action.template,
      { phone, email, chatId },
    );
    if ('reason' in built) return skip(built.reason);

    // BR-AUT-013: тихі години — лише клієнту і не для тесту.
    const delayMs = run.test ? 0 : await this.quietDelay(run.orgId, run.now);
    await this.notifications.enqueueChain(
      run.orgId,
      ctx.messageBranchId ?? undefined,
      built.chain,
      {
        meta,
        delayMs,
      },
    );
    return {
      ...base,
      status: 'DONE',
      channels: built.chain.map(s => s.channel),
      ...(delayMs > 0 && { delayedUntil: new Date(run.now.getTime() + delayMs).toISOString() }),
    };
  }

  // ─── Сповіщення працівникам ──────────────────────────────────────────────────────────────

  async employeeNotification(
    index: number,
    action: AutomationEmployeeNotificationAction,
    run: ActionRun,
  ): Promise<ActionResult> {
    const base = { index, type: action.type };
    const title = renderAutomationTemplate(action.title, run.vars);
    const body = action.body ? renderAutomationTemplate(action.body, run.vars) : null;

    if (run.test) {
      // Тест — лише зовнішній текст на телефон того, хто тестує (BR-AUT-051).
      if (!action.external) return { ...base, status: 'SKIPPED', reason: 'NO_CHANNEL' };
      return this.sendExternal(base, run, action.external, [
        { phone: run.test.phone, email: null, chatId: run.test.telegramChatId },
      ]);
    }

    const employees = await this.recipients(action, run);
    if (employees.length === 0) return { ...base, status: 'SKIPPED', reason: 'NO_RECIPIENTS' };

    if (action.inApp) {
      await this.prisma.employeeNotification.createMany({
        data: employees.map(e => ({
          orgId: run.orgId,
          employeeId: e.id,
          title,
          body,
          documentType: run.ctx.documentType,
          documentId: run.ctx.documentId,
          ruleId: run.rule.id,
        })),
      });
    }
    if (action.external) {
      // BR-AUT-022: Telegram-бот — підписаним працівникам; chat id — одним запитом на всіх.
      const chats = await this.telegram.chatIds(
        run.orgId,
        'employee',
        employees.map(e => e.id),
      );
      const to = employees.map(e => ({
        phone: e.phone,
        email: null,
        chatId: chats.get(e.id) ?? null,
      }));
      const ext = await this.sendExternal(base, run, action.external, to);
      if (!action.inApp) return { ...ext, recipients: employees.length };
    }
    return { ...base, status: 'DONE', recipients: employees.length };
  }

  /**
   * BR-AUT-020 / 023: одержувачі — конкретні, за роллю, «відповідальний з документа»; без
   * звільнених і видалених; ініціатор — лише якщо так задано в дії.
   */
  private async recipients(
    action: AutomationEmployeeNotificationAction,
    run: ActionRun,
  ): Promise<{ id: string; phone: string | null }[]> {
    const r = action.recipients;
    const ids = new Set(r.employeeIds);
    if (r.responsible) for (const id of await this.responsibleIds(run)) ids.add(id);
    const or: Prisma.EmployeeWhereInput[] = [];
    if (ids.size > 0) or.push({ id: { in: [...ids] } });
    if (r.roles.length > 0) or.push({ role: { in: [...r.roles] } });
    if (or.length === 0) return [];
    const rows = await this.prisma.employee.findMany({
      where: { orgId: run.orgId, deletedAt: null, status: { not: 'FIRED' }, OR: or },
      select: { id: true, phone: true },
      orderBy: { id: 'asc' },
      take: MAX_RECIPIENTS,
    });
    return action.notifyInitiator ? rows : rows.filter(e => e.id !== run.actorId);
  }

  private async responsibleIds(run: ActionRun): Promise<string[]> {
    const { ctx } = run;
    if (!ctx.responsibleIsAuthor) return ctx.responsibleIds;
    const author = await this.context.authorOf(run.orgId, ctx.documentType, ctx.documentId);
    return author ? [author] : [];
  }

  private async sendExternal(
    base: { index: number; type: AutomationActionTypeValue },
    run: ActionRun,
    external: NonNullable<AutomationEmployeeNotificationAction['external']>,
    to: readonly Contact[],
  ): Promise<ActionResult> {
    const meta: NotificationLogMeta = {
      ruleId: run.rule.id,
      documentType: run.ctx.documentType,
      documentId: run.ctx.documentId,
      eventKind: run.eventKind,
      isTest: !!run.test,
    };
    const channels: string[] = [];
    let lastReason: AutomationSkipReason = 'NO_CONTACT';
    const cache: ChannelCache = new Map();
    for (const person of to) {
      const built = await this.buildChain(
        run,
        { wanted: external.channels, allowed: AUTOMATION_EMPLOYEE_CHANNELS },
        external.template,
        person,
        cache,
      );
      if ('reason' in built) {
        lastReason = built.reason;
        continue;
      }
      await this.notifications.enqueueChain(
        run.orgId,
        run.ctx.messageBranchId ?? undefined,
        built.chain,
        { meta },
      );
      if (channels.length === 0) channels.push(...built.chain.map(s => s.channel));
    }
    if (channels.length === 0) {
      await this.logSkipped(run, firstChannel(external.channels), '', lastReason, meta);
      return { ...base, status: 'SKIPPED', reason: lastReason };
    }
    return { ...base, status: 'DONE', channels };
  }

  // ─── Створити задачу ─────────────────────────────────────────────────────────────────────

  async createTask(
    index: number,
    action: AutomationCreateTaskAction,
    run: ActionRun,
  ): Promise<ActionResult> {
    const base = { index, type: action.type };
    if (run.test) return { ...base, status: 'SKIPPED', reason: 'NO_CHANNEL' };
    const { ctx } = run;

    // BR-AUT-030: «відповідальний» — перший виконавець / виконавець / автор; далі запасний.
    const primary =
      action.assignee === 'responsible'
        ? ((await this.responsibleIds(run))[0] ?? null)
        : action.assignee.employeeId;
    const candidates = [primary, action.fallbackEmployeeId].filter((v): v is string => !!v);
    const available = candidates.length
      ? await this.prisma.employee.findMany({
          where: { orgId: run.orgId, id: { in: candidates }, deletedAt: null, status: 'ACTIVE' },
          select: { id: true },
          take: candidates.length,
        })
      : [];
    const assigneeId = candidates.find(c => available.some(a => a.id === c));
    if (!assigneeId) return { ...base, status: 'SKIPPED', reason: 'NO_ASSIGNEE' };

    // BR-AUT-032: відкрита задача того самого правила для того самого документа вже є.
    const existing = await this.prisma.task.findFirst({
      where: {
        orgId: run.orgId,
        deletedAt: null,
        automationRuleId: run.rule.id,
        entityType: ctx.documentType,
        entityId: ctx.documentId,
        status: { in: [...OPEN_TASK_STATUSES] },
      },
      select: { id: true },
    });
    if (existing) return { ...base, status: 'SKIPPED', reason: 'TASK_EXISTS', taskId: existing.id };

    // Ліміт задачі — на ВІДРЕНДЕРЕНИЙ текст: шаблон у межах, а підставлені змінні (назва
    // компанії, авто) розтягують його понад TASK_TITLE_MAX — таку задачу форма вже не збереже.
    const title = clip(renderAutomationTemplate(action.title, run.vars), TASK_TITLE_MAX);
    const task = await this.tasks.createByAutomation(run.orgId, {
      title,
      description: action.description
        ? clip(renderAutomationTemplate(action.description, run.vars), TASK_DESCRIPTION_MAX)
        : undefined,
      assigneeId,
      priority: action.priority,
      dueAt: new Date(run.occurredAt.getTime() + action.dueInHours * HOUR_MS),
      automationRuleId: run.rule.id,
      entityType: ctx.documentType,
      entityId: ctx.documentId,
      workOrderId: ctx.workOrderId,
      vehicleId: ctx.vehicleId,
      counterpartyId: ctx.client?.counterpartyId ?? null,
    });
    // Виконавцю — сповіщення в системі про нову задачу (крім власної дії, BR-AUT-023).
    if (assigneeId !== run.actorId) {
      await this.prisma.employeeNotification.create({
        data: {
          orgId: run.orgId,
          employeeId: assigneeId,
          title,
          documentType: 'TASK',
          documentId: task.id,
          ruleId: run.rule.id,
        },
      });
    }
    return { ...base, status: 'DONE', taskId: task.id };
  }

  // ─── Спільне ─────────────────────────────────────────────────────────────────────────────

  /**
   * BR-AUT-011: канали дії ∩ налаштовані канали філії, з адресою одержувача. Явний перелік правила
   * — лише його канали в його порядку; без переліку — усі налаштовані канали філії за пріоритетом,
   * який задав власник (серед дозволених для дії), Telegram-бот — там, де власник поставив його
   * рядок каналу; бажаний канал клієнта, якщо доступний, — першим. Адреса бота — chat id підписки:
   * не підписаний одержувач боту недоступний, ланцюжок іде далі. Причина порожнього ланцюжка — для журналу; бот у переліку правила, а в організації
   * його не підключено, — `TELEGRAM_BOT_NOT_CONNECTED`.
   */
  private async buildChain(
    run: ActionRun,
    choice: ChannelChoice,
    template: Template,
    contact: Contact,
    cache?: ChannelCache,
  ): Promise<{ chain: ChannelStep[] } | { reason: AutomationSkipReason }> {
    const recipientOf = (c: NotificationChannel): string | null =>
      c === EMAIL ? contact.email : c === TELEGRAM_BOT ? contact.chatId : contact.phone;
    const { wanted, allowed } = choice;
    const botMissing = async (): Promise<boolean> =>
      !!wanted?.includes(TELEGRAM_BOT) && !(await this.telegram.isConnected(run.orgId));
    let resolved: ResolvedChannel[];
    if (wanted && wanted.length > 0) {
      const addressable = wanted.filter(c => !!recipientOf(c));
      if (addressable.length === 0) {
        return { reason: (await botMissing()) ? 'TELEGRAM_BOT_NOT_CONNECTED' : 'NO_CONTACT' };
      }
      resolved = await this.branchChannels(run, addressable, cache);
      if (resolved.length === 0) {
        return { reason: (await botMissing()) ? 'TELEGRAM_BOT_NOT_CONNECTED' : 'NO_CHANNEL' };
      }
    } else {
      if (!contact.phone && !contact.email && !contact.chatId) return { reason: 'NO_CONTACT' };
      const branch = (await this.branchChannels(run, null, cache)).filter(r =>
        allowed.includes(r.channel),
      );
      if (branch.length === 0) return { reason: 'NO_CHANNEL' };
      resolved = preferredFirst(
        branch.filter(r => !!recipientOf(r.channel)),
        choice.preferred,
      );
      if (resolved.length === 0) return { reason: 'NO_CONTACT' };
    }
    const message = renderAutomationTemplate(template.body, run.vars);
    const subject = template.subject
      ? renderAutomationTemplate(template.subject, run.vars)
      : undefined;
    return {
      chain: resolved.map(r => ({
        channel: r.channel,
        provider: r.provider,
        senderName: r.senderName,
        message,
        subject: r.channel === EMAIL ? subject : undefined,
        recipient: recipientOf(r.channel) ?? '',
        externalTemplateId: r.externalTemplateId,
      })),
    };
  }

  /** Канали філії документа (`null` — за пріоритетом філії); один запит на набір у межах дії. */
  private branchChannels(
    run: ActionRun,
    wanted: readonly NotificationChannel[] | null,
    cache?: ChannelCache,
  ): Promise<ResolvedChannel[]> {
    const branchId = run.ctx.messageBranchId;
    if (!branchId) return Promise.resolve([]);
    const key = wanted ? wanted.join(',') : '*';
    let pending = cache?.get(key);
    if (!pending) {
      pending = this.notifications.resolveChannels(run.orgId, branchId, wanted);
      cache?.set(key, pending);
    }
    return pending;
  }

  private async quietDelay(orgId: string, now: Date): Promise<number> {
    const s = await this.prisma.organisationSettings.findFirst({
      where: { orgId },
      select: { quietHoursStart: true, quietHoursEnd: true },
    });
    return s ? quietHoursDelayMs(now, s.quietHoursStart, s.quietHoursEnd) : 0;
  }

  /** BR-AUT-050: «пропущено» з причиною — рядок журналу повідомлень без відправки. */
  private async logSkipped(
    run: ActionRun,
    channel: NotificationChannel,
    recipient: string,
    reason: AutomationSkipReason,
    meta: NotificationLogMeta,
  ): Promise<void> {
    await this.prisma.notificationLog.create({
      data: {
        orgId: run.orgId,
        branchId: run.ctx.messageBranchId,
        channel,
        provider: '',
        recipient,
        status: 'SKIPPED',
        skipReason: reason,
        ruleId: meta.ruleId,
        documentType: meta.documentType,
        documentId: meta.documentId,
        counterpartyId: meta.counterpartyId,
        isTest: meta.isTest ?? false,
      },
    });
  }
}
