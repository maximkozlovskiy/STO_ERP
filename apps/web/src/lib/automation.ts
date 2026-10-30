import {
  AUTOMATION_STATUS_LABELS,
  AUTOMATION_SKIP_REASONS,
  type AutomationDocumentTypeValue,
} from '@sto/shared';
import i18n from '@/i18n/config';
import '@/i18n/automation-ns';
import {
  invoiceStatusLabel,
  poStatusLabel,
  stockDocStatusLabel,
  supplierPaymentStatusLabel,
  supplierReturnStatusLabel,
  taskStatusLabel,
  woStatusLabel,
} from '@/i18n/enumLabel';

// Підписи й посилання конструктора правил і журналу автоматизації (docs/objects/automation.md).
// Коди — з `@sto/shared`; тексти — каталог `automation` (uk / en).

const tr = (key: string, fallback: string): string =>
  i18n.t(`automation:${key}`, { defaultValue: fallback });

export const automationDocumentTypeLabel = (type: string | null | undefined): string =>
  type ? tr(`documentTypes.${type}`, type) : '—';

export const automationEventKindLabel = (kind: string): string => tr(`eventKinds.${kind}`, kind);

export const automationChannelLabel = (channel: string): string =>
  tr(`channels.${channel}`, channel);

/**
 * Причина пропуску з журналу (BR-AUT-050): підпис кожного коду `AUTOMATION_SKIP_REASONS`; невідомий
 * код (новий на сервері, старіший web) — як є, а не порожнє місце.
 */
export function automationSkipReasonLabel(code: string | null | undefined): string {
  if (!code) return '';
  return (AUTOMATION_SKIP_REASONS as readonly string[]).includes(code)
    ? tr(`skipReasons.${code}`, code)
    : code;
}

/** Назва статусу документа правила: перелік — з `AUTOMATION_STATUS_LABELS` типу, підпис — i18n. */
export function automationStatusLabel(
  type: AutomationDocumentTypeValue,
  code: string | null | undefined,
): string {
  if (!code) return '—';
  switch (type) {
    case 'WORK_ORDER':
      return woStatusLabel(code);
    case 'INVOICE':
      return invoiceStatusLabel(code);
    case 'PURCHASE_ORDER':
      return poStatusLabel(code);
    case 'STOCK_DOCUMENT':
      return stockDocStatusLabel(code);
    case 'SUPPLIER_PAYMENT':
      return supplierPaymentStatusLabel(code);
    case 'SUPPLIER_RETURN':
      return supplierReturnStatusLabel(code);
    case 'TASK':
      return taskStatusLabel(code);
    case 'PAYMENT':
      return tr(`paymentStatuses.${code}`, AUTOMATION_STATUS_LABELS.PAYMENT[code] ?? code);
    case 'BOOKING':
      return tr(`bookingStatuses.${code}`, AUTOMATION_STATUS_LABELS.BOOKING[code] ?? code);
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

/** Статуси типу документа в порядку переліку (умови «у статус» / «зі статусу»). */
export const automationStatusCodes = (type: AutomationDocumentTypeValue): string[] =>
  Object.keys(AUTOMATION_STATUS_LABELS[type]);

// Посилання на документ — окремим модулем без каталогу: його бере дзвіночок оболонки.
export { automationDocumentHref } from './automation-href';
