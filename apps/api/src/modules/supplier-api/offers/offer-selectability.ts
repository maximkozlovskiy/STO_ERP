import type { PurchaseListItemSource, SupplierAnalogPolicy } from '@prisma/client';

/** Чому пропозицію не можна обрати — код для web (підказка біля «Обрати»). */
export type OfferNotSelectableReason =
  | 'itemNotOpen'
  | 'connectionDisabled'
  | 'noExchangeRate'
  | 'analogFromWorkOrder'
  | 'analogShowOnly'
  | 'analogNotInCatalog'
  | 'analogAmbiguous';

export interface OfferSelectabilityInput {
  isAnalog: boolean;
  matchStatus: string | null;
  matchedGoodId: string | null;
  itemSource: PurchaseListItemSource;
  itemOpen: boolean;
  /** Підключення пропозиції вимкнене чи видалене — вибір сервер відхилить (BR-SOFR-006). */
  connectionDisabled?: boolean;
  policy: SupplierAnalogPolicy;
  /** Ціна в гривні; null — курсу валюти пропозиції немає. */
  priceUah: number | null;
}

export interface OfferSelectability {
  selectable: boolean;
  reason: OfferNotSelectableReason | null;
  /** Вибір замінить товар позиції: знайденим у каталозі (`matchedGoodId`) чи новим (null). */
  replacesGood: boolean;
}

/**
 * BR-SOFR-005 (рішення власника 2026-10-18): аналог для позиції з наряду видно, але не
 * обирається; для ручної — за `supplierAnalogPolicy`: CREATE_AND_REPLACE — знайдений або новий
 * товар замінює товар позиції (неоднозначний збіг — ні, бо не знаємо, який); CATALOG_ONLY — лише
 * знайдений у каталозі; SHOW_ONLY — не обирається. Без курсу валюти ціну в гривню не перевести
 * (BR-SOFR-006) — теж не обирається.
 */
export function offerSelectability(i: OfferSelectabilityInput): OfferSelectability {
  const no = (reason: OfferNotSelectableReason): OfferSelectability => ({
    selectable: false,
    reason,
    replacesGood: false,
  });
  if (!i.itemOpen) return no('itemNotOpen');
  if (i.connectionDisabled) return no('connectionDisabled');
  if (i.priceUah === null) return no('noExchangeRate');
  if (!i.isAnalog) return { selectable: true, reason: null, replacesGood: false };
  if (i.itemSource === 'WORK_ORDER') return no('analogFromWorkOrder');
  if (i.policy === 'SHOW_ONLY') return no('analogShowOnly');
  const matched = i.matchStatus === 'matched' && !!i.matchedGoodId;
  if (i.policy === 'CATALOG_ONLY') {
    return matched
      ? { selectable: true, reason: null, replacesGood: true }
      : no('analogNotInCatalog');
  }
  if (i.matchStatus === 'ambiguous') return no('analogAmbiguous');
  return { selectable: true, reason: null, replacesGood: true };
}
