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

export { tEnum };
