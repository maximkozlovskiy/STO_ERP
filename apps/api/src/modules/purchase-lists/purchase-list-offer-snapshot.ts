import type { Prisma, PurchaseListItem } from '@prisma/client';

/**
 * Знімок обраної пропозиції постачальника на позиції списку купівлі (BR-SOFR-006, BR-PL-017).
 * Пропозиція живе тут, а не в рядку замовлення: рядки чернетки замовлення перезаписуються, а
 * планувальник відправки в API (BR-SCON-010) бере пропозицію саме з позицій.
 */
export const OFFER_SNAPSHOT_KEYS = [
  'offerConnectionId',
  'offerKey',
  'offerSupplierItemId',
  'offerArticle',
  'offerBrand',
  'offerWarehouseCode',
  'offerWarehouseName',
  'offerDeliveryDays',
  'offerDeliveryDate',
  'offerPrice',
  'offerCurrencyCode',
  'offerMultiplicity',
  'offerIsAnalog',
  'offeredAt',
  'offerChosenBy',
] as const satisfies ReadonlyArray<keyof PurchaseListItem>;

type SnapshotKey = (typeof OFFER_SNAPSHOT_KEYS)[number];
export type OfferSnapshot = Pick<PurchaseListItem, SnapshotKey>;

/**
 * BR-PL-017: нова частина позиції (розділення, остача при прийманні / скасуванні, автопідбір)
 * успадковує знімок і товар-оригінал. Повернення непідтвердженого постачальником знімок НЕ
 * копіює (BR-SCON-013) — там викликач ставить `CLEAR_OFFER_SNAPSHOT`.
 */
export function copyOfferSnapshot(
  item: Partial<Pick<PurchaseListItem, SnapshotKey | 'originalGoodId'>>,
): Partial<Prisma.PurchaseListItemUncheckedCreateInput> {
  const out: Record<string, unknown> = {};
  for (const k of OFFER_SNAPSHOT_KEYS) {
    const v = item[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  if (item.originalGoodId) out.originalGoodId = item.originalGoodId;
  return out;
}

/** Зняти вибір (BR-SOFR-006) / повернути без пропозиції (BR-SCON-013): постачальник і ціна лишаються. */
export const CLEAR_OFFER_SNAPSHOT = Object.freeze(
  Object.fromEntries(OFFER_SNAPSHOT_KEYS.map(k => [k, null])),
) as { [K in SnapshotKey]: null };

export function hasOfferSnapshot(
  item: Pick<PurchaseListItem, 'offerKey' | 'offerConnectionId'>,
): boolean {
  return !!item.offerKey && !!item.offerConnectionId;
}
