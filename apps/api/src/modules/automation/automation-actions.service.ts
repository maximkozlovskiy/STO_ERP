import { Injectable } from '@nestjs/common';
import type { AutomationMessageKind, NotificationChannel, Prisma } from '@prisma/client';
import {
  renderAutomationTemplate,
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
} from '../notifications/notifications.service';
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
  now: Date;
  /** «Надіслати тест» (BR-AUT-051): одержувач — той, хто тестує; без згоди й тихих годин. */
  test?: { phone: string | null; email: string | null };
}

const EMAIL: NotificationChannel = 'EMAIL';
const TELEGRAM_BOT: NotificationChannel = 'TELEGRAM_BOT';
const HOUR_MS = 3_600_000;
const MAX_RECIPIENTS = 500;

type Template = { subject?: string | undefined; body: string };

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
      counterpartyId: client?.counterpartyId ?? undefined,
      isTest: !!run.test,
    };
    const phone = run.test ? run.test.phone : (client?.phone ?? null);
    const email = run.test ? run.test.email : (client?.email ?? null);
    const skip = async (reason: AutomationSkipReason): Promise<ActionResult> => {
      await this.logSkipped(run, action.channels[0] ?? 'SMS', phone ?? email ?? '', reason, meta);
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

    const built = await this.buildChain(run, action.channels, action.template, phone, email);
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
      return this.sendExternal(base, run, action.external, [{ phone: run.test.phone }]);
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
      const ext = await this.sendExternal(base, run, action.external, employees);
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
    to: readonly { phone: string | null }[],
  ): Promise<ActionResult> {
    const meta: NotificationLogMeta = {
      ruleId: run.rule.id,
      documentType: run.ctx.documentType,
      documentId: run.ctx.documentId,
      isTest: !!run.test,
    };
    const channels: string[] = [];
    let lastReason: AutomationSkipReason = 'NO_CONTACT';
    for (const person of to) {
      const built = await this.buildChain(
        run,
        external.channels,
        external.template,
        person.phone,
        null,
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
      await this.logSkipped(run, external.channels[0] ?? 'SMS', '', lastReason, meta);
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

    const title = renderAutomationTemplate(action.title, run.vars);
    const task = await this.tasks.createByAutomation(run.orgId, {
      title,
      description: action.description
        ? renderAutomationTemplate(action.description, run.vars)
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
   * BR-AUT-011: канали правила в його порядку ∩ налаштовані канали філії, з адресою одержувача.
   * Telegram-бот до блоку 3 недоступний. Причина порожнього ланцюжка — для журналу.
   */
  private async buildChain(
    run: ActionRun,
    wanted: readonly NotificationChannel[],
    template: Template,
    phone: string | null,
    email: string | null,
  ): Promise<{ chain: ChannelStep[] } | { reason: AutomationSkipReason }> {
    const recipientOf = (c: NotificationChannel): string | null => (c === EMAIL ? email : phone);
    const external = wanted.filter(c => c !== TELEGRAM_BOT);
    const addressable = external.filter(c => !!recipientOf(c));
    if (addressable.length === 0) {
      const onlyBot = wanted.includes(TELEGRAM_BOT) && (phone || email);
      return { reason: onlyBot ? 'TELEGRAM_BOT_NOT_CONNECTED' : 'NO_CONTACT' };
    }
    const branchId = run.ctx.messageBranchId;
    const resolved = branchId
      ? await this.notifications.resolveChannels(run.orgId, branchId, addressable)
      : [];
    if (resolved.length === 0) return { reason: 'NO_CHANNEL' };
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
