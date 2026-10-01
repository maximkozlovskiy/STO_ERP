// Переклад enum-міток БЕЗ зміни @sto/shared statuses.ts (його споживає backend/PDF українською).
// Web-каталог statuses.json ключований MAP.CODE (напр. statuses:WO_STATUS.DRAFT). Fallback-ланцюг:
//   i18next(statuses:MAP.CODE) → shared-Ukrainian-map[code] → сам code (ніколи не гірше за сьогодні).
import i18n from './config';
import {
  WO_STATUS_LABELS,
  WO_PRIORITY_LABELS,
  WO_CATEGORY_LABELS,
  INVOICE_STATUS_LABELS,
  INVOICE_TYPE_LABELS,
  PO_STATUS_LABELS,
  SUPPLIER_RETURN_STATUS_LABELS,
  SUPPLIER_PAYMENT_STATUS_LABELS,
  PAYMENT_SOURCE_TYPE_LABELS,
  FISCAL_STATUS_LABELS,
  STOCK_DOC_STATUS_LABELS,
  STOCK_DOC_TYPE_LABELS,
  STOCK_MOVEMENT_TYPE_LABELS,
  SETTLEMENT_TX_TYPE_LABELS,
  EMPLOYEE_STATUS_LABELS,
  EMPLOYEE_ROLE_LABELS,
  COUNTERPARTY_TYPE_LABELS,
  CONTRACT_TYPE_LABELS,
  GOOD_TYPE_LABELS,
} from '@sto/shared';
// DELIVERY_STATUS_LABELS живе у web (panel-schema), а не в @sto/shared — Нова Пошта
// web-only. panel-schema НЕ імпортує enumLabel → циклу немає.
import { DELIVERY_STATUS_LABELS } from '@/lib/panel-schema';

type LabelMap = Record<string, string>;

/**
 * @param mapName ключ у statuses.json (напр. 'WO_STATUS')
 * @param fallbackMap shared українська мапа (fallback коли каталог не має ключа)
 * @param code enum-код (напр. 'DRAFT'); '' / null → '—'
 */
function tEnum(mapName: string, fallbackMap: LabelMap, code: string | null | undefined): string {
  if (!code) return '—';
  const key = `statuses:${mapName}.${code}`;
  const translated = i18n.t(key, { defaultValue: '' });
  if (translated) return translated;
  return fallbackMap[code] ?? code;
}

// Типовані обгортки — дзеркалять наявний ідіом `LABELS[x] ?? x`, мінімум churn у call-sites.
export const woStatusLabel = (c?: string | null) => tEnum('WO_STATUS', WO_STATUS_LABELS, c);
export const woPriorityLabel = (c?: string | null) => tEnum('WO_PRIORITY', WO_PRIORITY_LABELS, c);
export const woCategoryLabel = (c?: string | null) => tEnum('WO_CATEGORY', WO_CATEGORY_LABELS, c);
export const invoiceStatusLabel = (c?: string | null) =>
  tEnum('INVOICE_STATUS', INVOICE_STATUS_LABELS, c);
export const invoiceTypeLabel = (c?: string | null) =>
  tEnum('INVOICE_TYPE', INVOICE_TYPE_LABELS, c);
export const poStatusLabel = (c?: string | null) => tEnum('PO_STATUS', PO_STATUS_LABELS, c);
export const deliveryStatusLabel = (c?: string | null) =>
  tEnum('DELIVERY_STATUS', DELIVERY_STATUS_LABELS, c);
export const supplierReturnStatusLabel = (c?: string | null) =>
  tEnum('SUPPLIER_RETURN_STATUS', SUPPLIER_RETURN_STATUS_LABELS, c);
export const supplierPaymentStatusLabel = (c?: string | null) =>
  tEnum('SUPPLIER_PAYMENT_STATUS', SUPPLIER_PAYMENT_STATUS_LABELS, c);
export const paymentSourceTypeLabel = (c?: string | null) =>
  tEnum('PAYMENT_SOURCE_TYPE', PAYMENT_SOURCE_TYPE_LABELS, c);
export const fiscalStatusLabel = (c?: string | null) =>
  tEnum('FISCAL_STATUS', FISCAL_STATUS_LABELS, c);
export const stockDocStatusLabel = (c?: string | null) =>
  tEnum('STOCK_DOC_STATUS', STOCK_DOC_STATUS_LABELS, c);
export const stockDocTypeLabel = (c?: string | null) =>
  tEnum('STOCK_DOC_TYPE', STOCK_DOC_TYPE_LABELS, c);
export const stockMovementTypeLabel = (c?: string | null) =>
  tEnum('STOCK_MOVEMENT_TYPE', STOCK_MOVEMENT_TYPE_LABELS, c);
export const settlementTxTypeLabel = (c?: string | null) =>
  tEnum('SETTLEMENT_TX_TYPE', SETTLEMENT_TX_TYPE_LABELS, c);
export const employeeStatusLabel = (c?: string | null) =>
  tEnum('EMPLOYEE_STATUS', EMPLOYEE_STATUS_LABELS, c);
export const employeeRoleLabel = (c?: string | null) =>
  tEnum('EMPLOYEE_ROLE', EMPLOYEE_ROLE_LABELS, c);
export const counterpartyTypeLabel = (c?: string | null) =>
  tEnum('COUNTERPARTY_TYPE', COUNTERPARTY_TYPE_LABELS, c);
export const contractTypeLabel = (c?: string | null) =>
  tEnum('CONTRACT_TYPE', CONTRACT_TYPE_LABELS, c);
export const goodTypeLabel = (c?: string | null) => tEnum('GOOD_TYPE', GOOD_TYPE_LABELS, c);

// Банк-виписка (bank-statements) — enum-и живуть лише у web-namespace `bankStatements`
// (не в @sto/shared statuses), тож читаємо напряму через i18next з code-fallback.
const BANK_TX_MATCH_TYPE_FALLBACK: LabelMap = {
  PREPAYMENT: 'Аванс',
  SERVICE: 'Оплата послуг',
  INVOICE: 'Оплата рахунку',
  REFUND: 'Повернення',
  OTHER: 'Інше',
};
const BANK_TX_STATUS_FALLBACK: LabelMap = {
  UNMATCHED: 'Не рознесено',
  MATCHED: 'Рознесено',
  IGNORED: 'Проігноровано',
};
const PREVIEW_MATCH_STATUS_FALLBACK: LabelMap = {
  matched: 'Знайдено',
  ambiguous: 'Декілька збігів',
  notFound: 'Не знайдено',
  duplicate: 'Дублікат',
};

function tBankEnum(
  section: string,
  fallbackMap: LabelMap,
  code: string | null | undefined,
): string {
  if (!code) return '—';
  const translated = i18n.t(`bankStatements:enum.${section}.${code}`, { defaultValue: '' });
  if (translated) return translated;
  return fallbackMap[code] ?? code;
}

export const bankTxMatchTypeLabel = (c?: string | null) =>
  tBankEnum('matchType', BANK_TX_MATCH_TYPE_FALLBACK, c);
export const bankTxStatusLabel = (c?: string | null) =>
  tBankEnum('status', BANK_TX_STATUS_FALLBACK, c);
export const previewMatchStatusLabel = (c?: string | null) =>
  tBankEnum('previewStatus', PREVIEW_MATCH_STATUS_FALLBACK, c);

export { tEnum };
