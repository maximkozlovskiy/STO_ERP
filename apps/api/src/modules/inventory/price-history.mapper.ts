import type { PriceHistory } from '@prisma/client';

/** Рядок цінової історії товару для відповіді API — Decimal-поля як числа. */
export function toPriceHistoryRow(h: PriceHistory) {
  return {
    id: h.id,
    oldPrice: h.oldPrice != null ? Number(h.oldPrice) : null,
    newPrice: Number(h.newPrice),
    costPrice: h.costPrice != null ? Number(h.costPrice) : null,
    reason: h.reason,
    createdAt: h.createdAt,
  };
}
