import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { TelegramSubscriptionStatusDto } from './telegram-subscription.dto';

/** Кого шукати серед підписок: клієнтів або працівників (BR-AUT-041). */
export type TelegramRecipientKind = 'counterparty' | 'employee';

const targetWhere = (kind: TelegramRecipientKind, id: string) =>
  kind === 'counterparty' ? { counterpartyId: id } : { employeeId: id };

/**
 * Статус підписки для картки контрагента / працівника: найсвіжіша активна підписка (BR-AUT-041).
 * Функція, а не лише метод сервісу: картки читають статус своїм `PrismaService`.
 */
export async function telegramSubscriptionStatus(
  prisma: PrismaService,
  orgId: string,
  kind: TelegramRecipientKind,
  id: string,
): Promise<TelegramSubscriptionStatusDto> {
  const sub = await prisma.telegramSubscription.findFirst({
    where: { orgId, active: true, deletedAt: null, ...targetWhere(kind, id) },
    orderBy: { subscribedAt: 'desc' },
    select: { subscribedAt: true },
  });
  return { active: sub !== null, subscribedAt: sub?.subscribedAt.toISOString() ?? null };
}

/**
 * Одержувачі власного Telegram-бота (BR-AUT-011, 022, 041): чи підключено бота в організації,
 * chat id активних підписок, вимкнення підписки, коли бота заблокували. Спільне для дій правил
 * (`AutomationActionsService`), черги `sms` і модуля бота.
 */
@Injectable()
export class TelegramRecipientsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Бот підключено — токен збережено в налаштуваннях організації (BR-AUT-040). */
  async isConnected(orgId: string): Promise<boolean> {
    const row = await this.prisma.organisationSettings.findFirst({
      where: { orgId, telegramBotToken: { not: null } },
      select: { orgId: true },
    });
    return row !== null;
  }

  /** Токен бота (розшифровує розширення Prisma); `null` — бота не підключено. */
  async botToken(orgId: string): Promise<string | null> {
    const row = await this.prisma.organisationSettings.findFirst({
      where: { orgId },
      select: { telegramBotToken: true },
    });
    return row?.telegramBotToken || null;
  }

  /**
   * Chat id активних підписок: id клієнта / працівника → chat id найсвіжішої підписки. Один запит
   * на весь перелік (сповіщення працівникам — до сотень одержувачів).
   */
  async chatIds(
    orgId: string,
    kind: TelegramRecipientKind,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const target =
      kind === 'counterparty' ? { counterpartyId: { in: unique } } : { employeeId: { in: unique } };
    const rows = await this.prisma.telegramSubscription.findMany({
      where: { orgId, active: true, deletedAt: null, ...target },
      orderBy: { subscribedAt: 'desc' },
      select: { counterpartyId: true, employeeId: true, chatId: true },
      take: unique.length * 5,
    });
    const out = new Map<string, string>();
    for (const r of rows) {
      const id = kind === 'counterparty' ? r.counterpartyId : r.employeeId;
      if (id && !out.has(id)) out.set(id, r.chatId);
    }
    return out;
  }

  status(
    orgId: string,
    kind: TelegramRecipientKind,
    id: string,
  ): Promise<TelegramSubscriptionStatusDto> {
    return telegramSubscriptionStatus(this.prisma, orgId, kind, id);
  }

  /** Відписати з адмінки: усі активні підписки клієнта / працівника вимикаються (BR-AUT-041). */
  async unsubscribe(orgId: string, kind: TelegramRecipientKind, id: string): Promise<number> {
    const res = await this.prisma.telegramSubscription.updateMany({
      where: { orgId, active: true, deletedAt: null, ...targetWhere(kind, id) },
      data: { active: false, unsubscribedAt: new Date() },
    });
    return res.count;
  }

  /** Бота заблокували в цьому чаті — усі підписки чату в організації вимикаються (BR-AUT-041). */
  async deactivateChat(orgId: string, chatId: string): Promise<number> {
    const res = await this.prisma.telegramSubscription.updateMany({
      where: { orgId, chatId, active: true, deletedAt: null },
      data: { active: false, unsubscribedAt: new Date() },
    });
    return res.count;
  }
}
