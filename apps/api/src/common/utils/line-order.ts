/**
 * Порядок рядків документа без власної колонки порядку (замовлення постачальнику, складський
 * документ, повернення): рядки віддаються в тому порядку, в якому їх надіслали. `createdAt` за
 * замовчуванням — час початку транзакції, тобто однаковий для всіх рядків одного `createMany`,
 * тому запис проставляє `createdAt` зі зсувом 1 мс на рядок (`orderedLineStamps`), а читання
 * (картка, друк) сортує за ним (`LINE_ORDER_BY_CREATED`). Без явного `orderBy` Postgres віддає
 * рядки довільно (клас Bug #814).
 */
export const LINE_ORDER_BY_CREATED = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

/** Мітки `createdAt` для `count` рядків одного запису — у порядку надсилання. */
export function orderedLineStamps(count: number): Date[] {
  const base = Date.now();
  return Array.from({ length: count }, (_, i) => new Date(base + i));
}
