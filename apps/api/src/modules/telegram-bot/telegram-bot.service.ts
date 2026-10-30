import { randomBytes } from 'crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  TELEGRAM_BOT_PROVIDER,
  TELEGRAM_LINK_CODE_TTL_DAYS,
  translateError,
  type ValidationLocale,
} from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { err } from '../../common/utils/err';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  TelegramApiClient,
  TelegramApiError,
  TelegramNetworkError,
  type TelegramUpdate,
} from '../notifications/providers/telegram-api.client';
import {
  TelegramRecipientsService,
  type TelegramRecipientKind,
} from '../notifications/telegram-recipients.service';
import type { TelegramSubscriptionStatusDto } from '../notifications/telegram-subscription.dto';
import type { TelegramBotStatusDto, TelegramLinkDto } from './telegram-bot.dto';
import { TelegramBotScheduler } from './telegram-bot.scheduler';

const DAY_MS = 86_400_000;
/** Байтів випадковості в коді підписки: 16 → 22 символи base64url (128 біт). */
const LINK_CODE_BYTES = 16;
/** Параметр `start` deep-link-а Telegram: до 64 символів `A-Z a-z 0-9 _ -`. */
const START_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** `/start`, `/start КОД`, `/start@бот КОД`, `/stop`. */
const COMMAND_RE = /^\/(start|stop)(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?\s*$/;

/** Ключ відповіді бота (каталог i18n у `@sto/shared`). */
type BotReply =
  | 'bot.telegram.subscribed'
  | 'bot.telegram.codeExpired'
  | 'bot.telegram.codeUsed'
  | 'bot.telegram.codeUnknown'
  | 'bot.telegram.startHint'
  | 'bot.telegram.unsubscribed';

export interface TelegramTarget {
  kind: TelegramRecipientKind;
  id: string;
}

const targetData = (t: TelegramTarget) =>
  t.kind === 'counterparty' ? { counterpartyId: t.id } : { employeeId: t.id };

/**
 * Власний Telegram-бот організації (docs/objects/automation.md, BR-AUT-040, 041).
 *
 * - Підключення: `getMe` перевіряє токен; токен зберігається зашифрованим (ENCRYPTED_FIELDS),
 *   назовні — лише `connected` і `username`.
 * - Підписка: одноразовий код на 7 днів → `t.me/<бот>?start=<код>`; `/start <код>` прив'язує chat id,
 *   `/stop` відписує. СТО без публічної адреси — не webhook, а опитування `getUpdates` повторюваним
 *   job-ом черги `telegram-bot` (по одному на організацію з ботом).
 * - Повторна обробка того самого оновлення (рестарт до збереження offset, два екземпляри api)
 *   безпечна: код позначається використаним умовним записом (`usedAt: null`), повторне `/start` того
 *   самого чату дає те саме підтвердження, offset пишеться умовно за прочитаним.
 * - Відповіді бота — через чергу `sms` (повтори, BR-AUT-015); без інтернету опитування тихо
 *   завершується, наступний тік пробує знову.
 */
@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);
  /** Організації, чий останній тік опитування не дістався до Telegram: лог — лише на зміні стану. */
  private readonly offline = new Set<string>();
  /** Організації, чий тік опитування зараз іде в цьому процесі (див. `poll`). */
  private readonly polling = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly api: TelegramApiClient,
    private readonly recipients: TelegramRecipientsService,
    private readonly notifications: NotificationsService,
    private readonly scheduler: TelegramBotScheduler,
    private readonly audit: AuditService,
  ) {}

  // ─── Підключення (BR-AUT-040) ──────────────────────────────────────────────────────────────

  async status(orgId: string): Promise<TelegramBotStatusDto> {
    const [s, connected] = await Promise.all([
      this.prisma.organisationSettings.findFirst({
        where: { orgId },
        select: { telegramBotUsername: true },
      }),
      this.recipients.isConnected(orgId),
    ]);
    return { connected, username: connected ? (s?.telegramBotUsername ?? null) : null };
  }

  async connect(orgId: string, token: string, userId: string): Promise<TelegramBotStatusDto> {
    let username: string;
    try {
      const me = await this.api.getMe(token);
      if (!me.is_bot || !me.username) throw new TelegramApiError(401, 'not a bot');
      username = me.username;
    } catch (e: unknown) {
      if (e instanceof TelegramNetworkError) {
        throw new BadRequestException(err('err.telegramBot.unreachable'));
      }
      throw new BadRequestException(err('err.telegramBot.invalidToken'));
    }
    const before = await this.prisma.organisationSettings.findFirst({
      where: { orgId },
      select: { telegramBotUsername: true, telegramBotToken: true },
    });
    // Інший бот — інша послідовність update_id: offset старого бота пропустив би оновлення нового.
    const sameBot = before?.telegramBotToken === token;
    const data = {
      telegramBotToken: token,
      telegramBotUsername: username,
      ...(!sameBot && { telegramBotUpdateOffset: null }),
    };
    await this.prisma.organisationSettings.upsert({
      where: { orgId },
      create: { orgId, ...data },
      update: data,
    });
    await this.scheduler.start(orgId);
    this.recordAudit(orgId, userId, before?.telegramBotUsername ?? null, username);
    return { connected: true, username };
  }

  async disconnect(orgId: string, userId: string): Promise<TelegramBotStatusDto> {
    const before = await this.prisma.organisationSettings.findFirst({
      where: { orgId },
      select: { telegramBotUsername: true },
    });
    await this.prisma.organisationSettings.updateMany({
      where: { orgId },
      data: { telegramBotToken: null, telegramBotUsername: null, telegramBotUpdateOffset: null },
    });
    // Токен уже стерто: збій Redis не робить відключення помилкою 500. Тік без токена нічого не
    // робить, а «осиротілий» повторюваний job зніме наступний старт api.
    try {
      await this.scheduler.stop(orgId);
    } catch (e: unknown) {
      this.logger.warn(
        `Telegram-бот org=${orgId}: опитування не знято — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    this.offline.delete(orgId);
    this.recordAudit(orgId, userId, before?.telegramBotUsername ?? null, null);
    return { connected: false, username: null };
  }

  /** Аудит налаштувань: лише ім'я бота, токен у журнал не потрапляє. */
  private recordAudit(orgId: string, userId: string, from: string | null, to: string | null): void {
    if (from === to) return;
    this.audit
      .record(
        orgId,
        'OrganisationSettings',
        orgId,
        'UPDATE',
        userId,
        { telegramBotUsername: from },
        { telegramBotUsername: to },
      )
      .catch((e: unknown) =>
        this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : String(e)}`),
      );
  }

  // ─── Коди й підписки (BR-AUT-041) ──────────────────────────────────────────────────────────

  /** Персональне посилання підписки: криптостійкий одноразовий код на 7 днів. */
  async createLink(
    orgId: string,
    target: TelegramTarget,
    actorId: string,
  ): Promise<TelegramLinkDto> {
    const s = await this.prisma.organisationSettings.findFirst({
      where: { orgId, telegramBotToken: { not: null } },
      select: { telegramBotUsername: true },
    });
    if (!s?.telegramBotUsername) throw new BadRequestException(err('err.telegramBot.notConnected'));
    await this.assertTarget(orgId, target);
    const code = randomBytes(LINK_CODE_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + TELEGRAM_LINK_CODE_TTL_DAYS * DAY_MS);
    await this.prisma.telegramLinkCode.create({
      data: { orgId, code, expiresAt, createdById: actorId, ...targetData(target) },
    });
    return {
      code,
      url: `https://t.me/${s.telegramBotUsername}?start=${code}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async subscription(
    orgId: string,
    target: TelegramTarget,
  ): Promise<TelegramSubscriptionStatusDto> {
    await this.assertTarget(orgId, target);
    return this.recipients.status(orgId, target.kind, target.id);
  }

  /** Відписати з адмінки. */
  async unsubscribe(orgId: string, target: TelegramTarget): Promise<TelegramSubscriptionStatusDto> {
    await this.assertTarget(orgId, target);
    await this.recipients.unsubscribe(orgId, target.kind, target.id);
    return this.recipients.status(orgId, target.kind, target.id);
  }

  private async assertTarget(orgId: string, target: TelegramTarget): Promise<void> {
    const where = { id: target.id, orgId, deletedAt: null };
    const found =
      target.kind === 'counterparty'
        ? await this.prisma.counterparty.findFirst({ where, select: { id: true } })
        : await this.prisma.employee.findFirst({ where, select: { id: true } });
    if (!found) {
      throw new NotFoundException(
        err(target.kind === 'counterparty' ? 'err.counterparty.notFound' : 'err.employee.notFound'),
      );
    }
  }

  // ─── Опитування getUpdates ──────────────────────────────────────────────────────────────────

  /**
   * Один тік опитування організації. Помилка мережі чи Telegram не кидається (офлайн-вимога):
   * тік завершується, наступний пробує знову. Offset — наступний `update_id` після обробки,
   * записується умовно за прочитаним (паралельний тік іншого екземпляра api не відкотить його).
   *
   * BullMQ ставить наступну ітерацію повторюваного job-а, щойно поточна стала активною: тік, довший
   * за 3 с (повільний Telegram, тайм-аут 10 с), перекрився б наступним у сусідньому слоті
   * `concurrency` — обидва з тим самим offset, і бот відповів би на `/start` двічі. Тому в межах
   * процесу тік організації, що застав попередній незавершеним, пропускається.
   */
  async poll(orgId: string): Promise<{ processed: number }> {
    if (this.polling.has(orgId)) return { processed: 0 };
    this.polling.add(orgId);
    try {
      return await this.pollOnce(orgId);
    } finally {
      this.polling.delete(orgId);
    }
  }

  private async pollOnce(orgId: string): Promise<{ processed: number }> {
    const s = await this.prisma.organisationSettings.findFirst({
      where: { orgId },
      select: { telegramBotToken: true, telegramBotUpdateOffset: true, language: true },
    });
    const token = s?.telegramBotToken;
    if (!token) return { processed: 0 };
    const offset = s.telegramBotUpdateOffset;

    let updates: TelegramUpdate[];
    try {
      updates = await this.api.getUpdates(token, offset === null ? null : Number(offset));
    } catch (e: unknown) {
      if (e instanceof TelegramNetworkError || e instanceof TelegramApiError) {
        if (!this.offline.has(orgId)) {
          this.offline.add(orgId);
          this.logger.warn(`Telegram-бот org=${orgId}: опитування не вдалося — ${e.message}`);
        }
        return { processed: 0 };
      }
      throw e;
    }
    if (this.offline.delete(orgId))
      this.logger.log(`Telegram-бот org=${orgId}: зв'язок відновлено`);
    if (updates.length === 0) return { processed: 0 };

    const org = await this.prisma.organisation.findFirst({
      where: { id: orgId, deletedAt: null },
      select: { name: true },
    });
    const locale: ValidationLocale = s.language === 'en' ? 'en' : 'uk';
    const reply = { locale, orgName: org?.name ?? '' };
    const sorted = [...updates].sort((a, b) => a.update_id - b.update_id);
    for (const update of sorted) {
      try {
        await this.handleUpdate(orgId, update, reply);
      } catch (e: unknown) {
        // Одне зламане оновлення не блокує решту: offset іде далі, інакше бот «застряг» би.
        this.logger.error(
          `Telegram-бот org=${orgId}: оновлення ${update.update_id} не оброблено — ` +
            (e instanceof Error ? e.message : String(e)),
        );
      }
    }
    const next = BigInt(sorted[sorted.length - 1].update_id + 1);
    await this.prisma.organisationSettings.updateMany({
      where: { orgId, telegramBotUpdateOffset: offset },
      data: { telegramBotUpdateOffset: next },
    });
    return { processed: sorted.length };
  }

  private async handleUpdate(
    orgId: string,
    update: TelegramUpdate,
    reply: { locale: ValidationLocale; orgName: string },
  ): Promise<void> {
    const msg = update.message;
    // Лише особистий чат: підписка групи розсилала б повідомлення клієнта всім її учасникам.
    if (!msg?.text || msg.chat.type !== 'private') return;
    const match = COMMAND_RE.exec(msg.text.trim());
    if (!match) return;
    const chatId = String(msg.chat.id);
    const key =
      match[1] === 'stop'
        ? await this.handleStop(orgId, chatId)
        : await this.handleStart(orgId, chatId, match[2] ?? null);
    const text = translateError(key, reply.locale, { org: reply.orgName });
    await this.notifications.enqueueChain(orgId, undefined, [
      {
        channel: 'TELEGRAM_BOT',
        provider: TELEGRAM_BOT_PROVIDER,
        senderName: '',
        message: text,
        recipient: chatId,
      },
    ]);
  }

  private async handleStart(orgId: string, chatId: string, code: string | null): Promise<BotReply> {
    if (!code) return 'bot.telegram.startHint';
    if (!START_CODE_RE.test(code)) return 'bot.telegram.codeUnknown';
    // Код чужої організації — «невідомий»: межі org (BR-AUT-052).
    const link = await this.prisma.telegramLinkCode.findFirst({
      where: { orgId, code, deletedAt: null },
      select: { id: true, counterpartyId: true, employeeId: true, expiresAt: true, usedAt: true },
    });
    const target = link ? linkTarget(link) : null;
    if (!link || !target) return 'bot.telegram.codeUnknown';
    if (link.usedAt) return this.repeatedStart(orgId, target, chatId);
    const now = new Date();
    if (link.expiresAt.getTime() <= now.getTime()) return 'bot.telegram.codeExpired';
    if (!(await this.targetAlive(orgId, target))) return 'bot.telegram.codeUnknown';

    const claimed = await this.prisma.$transaction(async tx => {
      const res = await tx.telegramLinkCode.updateMany({
        where: { id: link.id, orgId, usedAt: null },
        data: { usedAt: now },
      });
      if (res.count === 0) return false;
      const existing = await tx.telegramSubscription.findFirst({
        where: { orgId, chatId, deletedAt: null, ...targetData(target) },
        select: { id: true },
      });
      if (existing) {
        await tx.telegramSubscription.update({
          where: { id: existing.id, orgId },
          data: { active: true, subscribedAt: now, unsubscribedAt: null },
        });
      } else {
        await tx.telegramSubscription.create({
          data: { orgId, chatId, active: true, subscribedAt: now, ...targetData(target) },
        });
      }
      return true;
    });
    return claimed ? 'bot.telegram.subscribed' : this.repeatedStart(orgId, target, chatId);
  }

  /** Код уже використано: той самий чат підписаний — те саме підтвердження (ідемпотентно). */
  private async repeatedStart(
    orgId: string,
    target: TelegramTarget,
    chatId: string,
  ): Promise<BotReply> {
    const sub = await this.prisma.telegramSubscription.findFirst({
      where: { orgId, chatId, active: true, deletedAt: null, ...targetData(target) },
      select: { id: true },
    });
    return sub ? 'bot.telegram.subscribed' : 'bot.telegram.codeUsed';
  }

  private async targetAlive(orgId: string, target: TelegramTarget): Promise<boolean> {
    const where = { id: target.id, orgId, deletedAt: null };
    const row =
      target.kind === 'counterparty'
        ? await this.prisma.counterparty.findFirst({ where, select: { id: true } })
        : await this.prisma.employee.findFirst({
            where: { ...where, status: { not: 'FIRED' } },
            select: { id: true },
          });
    return row !== null;
  }

  private async handleStop(orgId: string, chatId: string): Promise<BotReply> {
    await this.prisma.telegramSubscription.updateMany({
      where: { orgId, chatId, active: true, deletedAt: null },
      data: { active: false, unsubscribedAt: new Date() },
    });
    return 'bot.telegram.unsubscribed';
  }
}

function linkTarget(link: {
  counterpartyId: string | null;
  employeeId: string | null;
}): TelegramTarget | null {
  if (link.counterpartyId) return { kind: 'counterparty', id: link.counterpartyId };
  if (link.employeeId) return { kind: 'employee', id: link.employeeId };
  return null;
}
