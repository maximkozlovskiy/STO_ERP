import type { Prisma, PurchaseListItem, SupplierOffer } from '@prisma/client';

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

/** Знімок обраної пропозиції для позиції (BR-SOFR-006): ціна й валюта — як у постачальника. */
export function offerSnapshot(offer: SupplierOffer, chosenBy: 'MANUAL' | 'AUTO'): OfferSnapshot {
  return {
    offerConnectionId: offer.connectionId,
    offerKey: offer.offerKey,
    offerSupplierItemId: offer.supplierItemId,
    offerArticle: offer.article,
    offerBrand: offer.brand,
    offerWarehouseCode: offer.warehouseCode,
    offerWarehouseName: offer.warehouseName,
    offerDeliveryDays: offer.deliveryDays,
    offerDeliveryDate: offer.deliveryDate,
    offerPrice: offer.price,
    offerCurrencyCode: offer.currencyCode,
    offerMultiplicity: offer.multiplicity,
    offerIsAnalog: offer.isAnalog,
    offeredAt: new Date(),
    offerChosenBy: chosenBy,
  };
}

/**
 * Нова частина позиції з тими самими зв'язками (BR-PL-007, BR-PL-017): список, товар, склад,
 * джерело, рядок наряду, постачальник, ціна, примітка — і знімок пропозиції (`snapshot: 'copy'`)
 * або без нього (`'none'` — повернення непідтвердженого, BR-SCON-013). Спільне для «Розділити»,
 * остачі при прийманні / скасуванні й автопідбору.
 */
export function itemPartData(
  item: PurchaseListItem,
  quantity: number,
  opts: { status?: 'OPEN' | 'CANCELLED'; snapshot?: 'copy' | 'none' } = {},
): Prisma.PurchaseListItemUncheckedCreateInput {
  return {
    orgId: item.orgId,
    listId: item.listId,
    goodId: item.goodId,
    warehouseId: item.warehouseId,
    quantity,
    ...(opts.status ? { status: opts.status } : {}),
    source: item.source,
    workOrderId: item.workOrderId,
    workOrderPartId: item.workOrderPartId,
    supplierId: item.supplierId,
    expectedPrice: item.expectedPrice,
    notes: item.notes,
    ...(opts.snapshot === 'none'
      ? item.originalGoodId
        ? { originalGoodId: item.originalGoodId }
        : {}
      : copyOfferSnapshot(item)),
  };
}

/**
 * Заміна товару позиції: повернення до оригіналу знімає `originalGoodId`, інша заміна — запам'ятовує
 * оригінал (перший, не проміжний аналог).
 */
export function goodSwap(
  item: Pick<PurchaseListItem, 'goodId' | 'originalGoodId'>,
  target: string,
): { goodId: string; originalGoodId: string | null } {
  const original = item.originalGoodId ?? item.goodId;
  return { goodId: target, originalGoodId: target === original ? null : original };
}
