import type { Prisma } from '@prisma/client';
import { SHAREABLE_STATUSES } from './work-orders.fsm';

/** BR-WO-032: посилання на кошторис живе 30 днів від створення (рішення власника 2026-10-24). */
export const SHARE_TOKEN_TTL_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Момент, після якого щойно виданий токен перестає відкривати кошторис. */
export function shareTokenExpiry(now: Date): Date {
  return new Date(now.getTime() + SHARE_TOKEN_TTL_DAYS * DAY_MS);
}

/** Токен ще відкриває кошторис: є, і термін не минув. `null`-термін (наряди до BR-WO-032) — мертвий. */
export function isShareTokenLive(
  wo: { shareToken: string | null; shareTokenExpiresAt: Date | null },
  now: Date,
): wo is { shareToken: string; shareTokenExpiresAt: Date } {
  return !!wo.shareToken && !!wo.shareTokenExpiresAt && wo.shareTokenExpiresAt > now;
}

/**
 * Єдиний відбір наряду за публічним токеном — і для JSON-кошторису, і для PDF/XLSX/DOCX-експорту:
 * токен не прострочений (`null`-термін теж відкидає `gt`), наряд не видалений і в статусі, яким
 * дозволено ділитися. Прострочений токен не відрізняється від невідомого — той самий 404.
 */
export function liveShareTokenWhere(token: string, now: Date): Prisma.WorkOrderWhereInput {
  return {
    shareToken: token,
    shareTokenExpiresAt: { gt: now },
    deletedAt: null,
    status: { in: [...SHAREABLE_STATUSES] },
  };
}
