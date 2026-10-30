import {
  AUTOMATION_STATUS_LABELS,
  AUTOMATION_SKIP_REASONS,
  type AutomationDocumentTypeValue,
} from '@sto/shared';
import i18n from '@/i18n/config';
import {
  invoiceStatusLabel,
  poStatusLabel,
  stockDocStatusLabel,
  supplierPaymentStatusLabel,
  supplierReturnStatusLabel,
  taskStatusLabel,
  woStatusLabel,
} from '@/i18n/enumLabel';
import { canOpenRoute } from '@/lib/nav';

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

/**
 * Сторінка документа з журналу чи дзвіночка: список із карткою в адресі (`?open=`), повернення
 * постачальнику — на сторінці купівлі (`?openReturn=`). `null` — сторінки немає
 * або роль її не відкриває (BR-AUT-021: текст сповіщення видно, перехід — ні).
 */
export function automationDocumentHref(
  type: string | null | undefined,
  id: string | null | undefined,
  role: string | null | undefined,
): string | null {
  if (!type || !id) return null;
  const enc = encodeURIComponent(id);
  const route = ((): { list: string; href: string } | null => {
    switch (type) {
      case 'WORK_ORDER':
        return { list: '/work-orders', href: `/work-orders?open=${enc}` };
      case 'INVOICE':
        return { list: '/invoices', href: `/invoices?open=${enc}` };
      case 'PURCHASE_ORDER':
        return { list: '/purchase-orders', href: `/purchase-orders?open=${enc}` };
      case 'SUPPLIER_RETURN':
        return { list: '/purchase-orders', href: `/purchase-orders?openReturn=${enc}` };
      case 'STOCK_DOCUMENT':
        return { list: '/stock-documents', href: `/stock-documents?open=${enc}` };
      case 'TASK':
        return { list: '/tasks', href: `/tasks?open=${enc}` };
      // Окремої картки оплати немає: оплата клієнта — у касі, оплата постачальнику — у графіку
      // оплат «Купівлі» (старі адреси `/payments/:id`, `/supplier-payments/:id` ведуть туди ж).
      case 'PAYMENT':
        return { list: '/cash', href: '/cash' };
      case 'SUPPLIER_PAYMENT':
        return { list: '/purchase-orders', href: '/purchase-orders?tab=schedule' };
      case 'BOOKING':
        return { list: '/bookings', href: '/bookings' };
      default:
        return null;
    }
  })();
  if (!route) return null;
  return canOpenRoute(route.list, role) ? route.href : null;
}
