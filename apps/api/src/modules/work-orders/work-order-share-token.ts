import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { translateError } from '@sto/shared';
import type { PrismaService } from '../../prisma/prisma.service';
import { getLocale } from '../../common/tenant/tenant-context';
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

/**
 * Єдиний `include` наряду для публічного кошторису — спільний для JSON-перегляду і експорту
 * (PDF/XLSX/DOCX): авто, контрагент, філія, роботи й запчастини (по 500, активні, за часом).
 * Набір стовпців — надмножина: JSON-DTO читає `id`/`notes`/`goodId`, експорт їх ігнорує (зайві
 * read-only поля нічого не коштують). Раніше два ідентичні блоки `include` розходилися на одній
 * правці — jscpd позначав їх клоном; тепер одне джерело правди.
 */
export const SHARE_WO_INCLUDE = {
  vehicle: { select: { make: true, model: true, licensePlate: true } },
  counterparty: { select: { firstName: true, lastName: true, companyName: true } },
  branch: { select: { name: true } },
  lines: {
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    take: 500,
    select: {
      id: true,
      normoHours: true,
      price: true,
      amount: true,
      notes: true,
      work: { select: { name: true } },
    },
  },
  parts: {
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    take: 500,
    select: {
      id: true,
      goodId: true,
      quantity: true,
      price: true,
      amount: true,
      unitOfMeasureId: true,
      good: {
        select: { name: true, unit: true, unitOfMeasure: { select: { shortName: true } } },
      },
    },
  },
} satisfies Prisma.WorkOrderInclude;

/** Наряд за публічним токеном із `SHARE_WO_INCLUDE`; тип повернення зберігає обрані relation-поля. */
export type ShareableWorkOrder = Prisma.WorkOrderGetPayload<{ include: typeof SHARE_WO_INCLUDE }>;

/**
 * Завантажує наряд за живим токеном для публічного кошторису — спільне для JSON-перегляду і
 * експорту. Прострочений / відкликаний / невідомий токен → 404 `shareLinkInvalid` (той самий,
 * що й для чужого наряду — не розкриваємо існування). Викликати всередині `runUnscoped` (orgId
 * відсутній: публічний неавтентифікований доступ ідентифікує наряд за 16-байтним токеном).
 */
export async function loadShareableWorkOrder(
  prisma: PrismaService,
  token: string,
): Promise<ShareableWorkOrder> {
  const wo = await prisma.workOrder.findFirst({
    where: liveShareTokenWhere(token, new Date()),
    include: SHARE_WO_INCLUDE,
  });
  if (!wo) {
    throw new NotFoundException(translateError('err.workOrder.shareLinkInvalid', getLocale()));
  }
  return wo;
}
