'use client';

import dynamic from 'next/dynamic';

import {
  Receipt,
  CreditCard,
  Calendar,
  Shield,
  ClipboardList,
  User,
  Wallet,
  ShoppingCart,
  RotateCcw,
  Warehouse,
  ListChecks,
} from 'lucide-react';
import {
  invoiceStatusLabel,
  woStatusLabel,
  poStatusLabel,
  supplierPaymentStatusLabel,
  supplierReturnStatusLabel,
  fiscalStatusLabel,
  purchaseListStatusLabel,
} from '@/i18n/enumLabel';
import { fmtBankCurrencySuffix, fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { displayCounterpartyName } from '@/lib/utils';
import type {
  LinkedEntityConfig,
  LinkedItemBadge,
  LinkedSectionItem,
} from '@/components/ui/LinkedDocumentsPanel';
import i18n from '@/i18n/config';
import type { LinkedNav } from '@/lib/linked-nav';
import { SUPPLIER_PAYMENT_STATUS_BADGE, type ApiSchema } from '@sto/shared';

// Вікно сторно відкривається лише дією в «Пов'язаних документах» — окремим чанком, а не в first load
// сторінок «Рахунки» й «Наряди» (бюджет сторінки 560 КБ, `check-page-budget.mjs`).
const PaymentReversalModal = dynamic(
  () => import('@/components/ui/PaymentReversalModal').then(m => m.PaymentReversalModal),
  { ssr: false },
);

// Реєстр конфігів пов'язаних документів. Кожен конфіг — фабрика (nav) => config,
// бо навігація приходить з хука useLinkedNav() у компоненті, а самі секції статичні.

function fmt(n: string | number): string {
  return fmtMoney(Number(n));
}

/**
 * Сума документа — у його валюті (Bug #1018): доларова оплата чи рахунок не «20,00 ₴», а
 * «20,00 USD». Без коду (базова валюта, старий рядок) — «₴». Оплати клієнта, рахунки, оплати
 * постачальнику.
 */
function fmtPaymentAmount(row: { amount: string | number; currencyCode?: string | null }): string {
  return `${fmt(row.amount)} ${fmtBankCurrencySuffix(row.currencyCode)}`;
}

// ─── Спільні badge/label мапи ──────────────────────────────

export const INVOICE_STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-secondary text-muted-foreground',
  SENT: 'bg-info-subtle text-info-text',
  // Must match INVOICE_STATUS_BADGE['PARTIALLY_PAID'] = 'warning' — use warning, not destructive.
  PARTIALLY_PAID: 'bg-warning-subtle text-warning-text',
  PAID: 'bg-success-subtle text-success',
  // Must match INVOICE_STATUS_BADGE['OVERDUE'] = 'warning' — use warning, not destructive.
  OVERDUE: 'bg-warning-subtle text-warning-text',
  CANCELLED: 'bg-secondary text-muted-foreground',
};

// Record<union, string> (не Record<string, string>): мапа вичерпна щодо
// CalendarSlotStatus, і новий статус у Prisma-схемі зламає build тут, а не
// просто провалиться у `?? row.status` з англійським кодом на екрані.
const SLOT_STATUS_LABELS: Record<LinkedSlotRow['status'], string> = {
  AVAILABLE: 'Вільний',
  BOOKED: 'Заброньовано',
  BLOCKED: 'Заблоковано',
};

const METHOD_LABELS: Record<string, string> = {
  CASH: 'Готівка',
  CARD: 'Картка',
  TRANSFER: 'Переказ',
  ONLINE: 'Онлайн',
};

function invoiceStatusBadge(status: string) {
  return {
    label: invoiceStatusLabel(status),
    className: INVOICE_STATUS_COLORS[status] ?? 'bg-secondary text-muted-foreground',
  };
}

// ─── Row shapes returned by backend linked-documents endpoints ──
// Рядки, які бек описує DTO-класами, беремо зі згенерованих типів — рукописні
// дублі розходились із контрактом (`status: string` замість union,
// `amount: string | number` там, де сервіс уже робить `Number()`).

type LinkedInvoiceRow = ApiSchema<'LinkedInvoiceRowDto'>;
type LinkedPaymentRow = ApiSchema<'LinkedPaymentRowDto'>;
type LinkedSlotRow = ApiSchema<'LinkedCalendarSlotRowDto'>;
type LinkedWarrantyRow = ApiSchema<'LinkedWarrantyRowDto'>;
// Контрагент і наряд у linked-панелі — рахункові DTO (та сама форма у work-order).
type LinkedCounterpartyRow = ApiSchema<'InvoiceLinkedCounterpartyRowDto'>;
type LinkedWorkOrderRow = ApiSchema<'InvoiceLinkedWorkOrderRowDto'>;

// Решта — поки рукописні: відповідні endpoints ще не анотовані DTO.
interface LinkedSupplierPaymentRow {
  id: string;
  number: string;
  amount: string | number;
  /** Валюта оплати (валюта її джерела коштів); null — базова. */
  currencyCode?: string | null;
  method: string;
  status: string;
  documentDate: string | null;
}
interface LinkedPurchaseOrderRow {
  id: string;
  number: string;
  status: string;
  /** null — роль не бачить закупівельних цін (список купівлі для приймальні, §2.1). */
  totalAmount: string | number | null;
  /** Символ валюти замовлення — віддає лише список купівлі; решта секцій — гривня. */
  currencySymbol?: string | null;
}
interface LinkedPurchaseListRow {
  id: string;
  number: string;
  status: string;
  createdAt: string;
}
// ─── Спільні section-builders (переюз між конфігами) ───────

/** Секція «Списки купівлі» — списки з позиціями наряду чи замовлення (docs/objects/purchase-list.md).
 * Картка списку купівлі показує тут списки, обʼєднані в нього (`title` — свій). */
function purchaseListSection(nav: LinkedNav, { title }: { title?: string } = {}) {
  return {
    key: 'purchaseLists',
    title: title ?? i18n.t('common:linkedDocuments.purchaseLists'),
    icon: ListChecks,
    mapRow: (row: LinkedPurchaseListRow) => ({
      id: row.id,
      primary: `Список ${row.number}`,
      secondary: fmtDate(row.createdAt),
      badge: {
        label: purchaseListStatusLabel(row.status),
        className: 'bg-secondary text-muted-foreground',
      },
      preview: {
        title: `Список купівлі ${row.number}`,
        rows: [
          { label: 'Статус', value: purchaseListStatusLabel(row.status) },
          { label: 'Створено', value: fmtDate(row.createdAt) },
        ],
      },
      navigate: () => nav.toPurchaseList(row.id),
    }),
  };
}

/** Секція «Контрагент» — однаковий рядок скрізь, навігація до картки контрагента. */
function counterpartySection(nav: LinkedNav) {
  return {
    key: 'counterparty',
    title: 'Контрагент',
    icon: User,
    mapRow: (row: LinkedCounterpartyRow) => ({
      id: row.id,
      primary: displayCounterpartyName(row),
      secondary: row.phone ?? undefined,
      preview: {
        title: displayCounterpartyName(row),
        rows: [...(row.phone ? [{ label: 'Телефон', value: row.phone }] : [])],
      },
      navigate: () => nav.toCounterparty(row.id),
    }),
  };
}

/** Секція «Наряд» — для рахунку (один наряд, `workOrder`); список купівлі — `workOrders` (кілька). */
function workOrderSection(
  nav: LinkedNav,
  { key = 'workOrder', title }: { key?: string; title?: string } = {},
) {
  return {
    key,
    title: title ?? i18n.t('common:linkedDocuments.workOrder'),
    icon: ClipboardList,
    mapRow: (row: LinkedWorkOrderRow) => ({
      id: row.id,
      primary: `Наряд ${row.number}`,
      badge: {
        label: woStatusLabel(row.status),
        className: 'bg-secondary text-muted-foreground',
      },
      preview: {
        title: `Наряд ${row.number}`,
        rows: [{ label: 'Статус', value: woStatusLabel(row.status) }],
      },
      navigate: () => nav.toWorkOrder(row.id),
    }),
  };
}

/** Секція «Рахунки» — однаковий рядок у work-order та картці контрагента.
 * Різниться лише `secondary`: наряд показує дату документа, картка контрагента — суму. */
function invoiceSection(
  nav: LinkedNav,
  { secondaryField = 'date' }: { secondaryField?: 'date' | 'amount' } = {},
) {
  return {
    key: 'invoices',
    title: 'Рахунки',
    icon: Receipt,
    mapRow: (row: LinkedInvoiceRow) => ({
      id: row.id,
      primary: `Рахунок ${row.number}`,
      secondary:
        secondaryField === 'amount'
          ? fmtPaymentAmount(row)
          : row.documentDate
            ? fmtDate(row.documentDate)
            : undefined,
      badge: invoiceStatusBadge(row.status),
      preview: {
        title: `Рахунок ${row.number}`,
        rows: [
          { label: 'Статус', value: invoiceStatusLabel(row.status) },
          { label: 'Сума', value: fmtPaymentAmount(row) },
          ...(row.documentDate ? [{ label: 'Дата', value: fmtDate(row.documentDate) }] : []),
        ],
      },
      navigate: () => nav.toInvoice(row.id),
    }),
  };
}

/** Позначка сторнованої оплати — замість позначки чека: чек сторнованої оплати скасовано. */
const REVERSED_PAYMENT_BADGE: LinkedItemBadge = { label: 'Сторновано', variant: 'destructive' };

/** Рядок прев'ю «Сторновано: дата» для сторнованої оплати. */
function reversedPreviewRows(row: LinkedPaymentRow) {
  return row.reversedAt ? [{ label: 'Сторновано', value: fmtDateTime(row.reversedAt) }] : [];
}

/** Хто сторнує оплату — ті самі ролі, що в маршруту `POST /payments/:id/reverse` і в касі. */
export const PAYMENT_REVERSAL_ROLES = ['OWNER', 'ADMIN', 'ACCOUNTANT'] as const;

/**
 * BR-PAY-024: дія «Сторнувати» для рядка оплати — лише не сторнованої, не касової й не онлайн-оплати
 * QR; касова — підказка «Сторнується в касі» (сторно каси — ще й рядок протилежного напряму). Касову
 * визначає сервер (`inCashDesk`): стара готівкова оплата без `sourceType` теж лежить у касі, і
 * `POST /payments/:id/reverse` її відхиляє. Тексти — `i18n.t` у момент побудови рядка: конфіг не хук,
 * а мова на той момент уже поточна.
 */
function paymentReversalFields(
  row: LinkedPaymentRow,
): Pick<LinkedSectionItem, 'dialogAction' | 'actionHint'> {
  if (row.reversedAt || row.isOnline) return {};
  // BR-PAY-029: чек ще в черзі ПРРО — сторно відмовить, поки ПРРО не відповів.
  if (row.fiscalStatus === 'QUEUED') {
    return {
      actionHint: {
        text: i18n.t('cash:paymentReversal.fiscalQueuedHint'),
        roles: PAYMENT_REVERSAL_ROLES,
      },
    };
  }
  if (row.inCashDesk || row.sourceType === 'CASH_REGISTER') {
    return {
      actionHint: {
        text: i18n.t('cash:paymentReversal.cashHint'),
        roles: PAYMENT_REVERSAL_ROLES,
      },
    };
  }
  const amountText = fmtPaymentAmount(row);
  const dateText = fmtDateTime(row.createdAt);
  return {
    dialogAction: {
      label: i18n.t('cash:paymentReversal.action'),
      ariaLabel: i18n.t('cash:paymentReversal.actionAria', { amount: amountText, date: dateText }),
      roles: PAYMENT_REVERSAL_ROLES,
      render: ({ open, onClose, onDone }) => (
        <PaymentReversalModal
          open={open}
          onClose={onClose}
          onReversed={onDone}
          payment={{
            id: row.id,
            amountText,
            dateText,
            // Назва способу — з довідника НДІ (картка бере її сама); старі коди CASH/CARD/… — підписом.
            methodLabel: METHOD_LABELS[row.method] ?? null,
            methodCode: row.method,
          }}
        />
      ),
    },
  };
}

// ─── WorkOrder config (behavior-preserving дзеркало старої панелі) ──

export function workOrderLinkedConfig(
  nav: LinkedNav,
  /**
   * `canOpenWarranties` — роль бачить вкладку «Гарантії» (`GET /warranties`): лише тоді клік по
   * гарантії веде туди. Механік відкриває наряд, але вкладки не має — переходу для нього немає.
   */
  { canOpenWarranties = false }: { canOpenWarranties?: boolean } = {},
): LinkedEntityConfig {
  return {
    fetchPath: id => `/work-orders/${id}/linked-documents`,
    sections: [
      invoiceSection(nav),
      {
        key: 'payments',
        title: 'Оплати',
        icon: CreditCard,
        mapRow: (row: LinkedPaymentRow) => ({
          id: row.id,
          primary: fmtPaymentAmount(row),
          secondary: fmtDateTime(row.createdAt),
          badge: row.reversedAt ? REVERSED_PAYMENT_BADGE : undefined,
          ...paymentReversalFields(row),
          preview: {
            title: 'Оплата',
            rows: [
              { label: 'Сума', value: fmtPaymentAmount(row) },
              { label: 'Метод', value: METHOD_LABELS[row.method] ?? row.method },
              { label: 'Дата', value: fmtDateTime(row.createdAt) },
              ...reversedPreviewRows(row),
              ...(row.notes ? [{ label: 'Примітка', value: row.notes }] : []),
            ],
          },
        }),
      },
      {
        key: 'calendarSlots',
        title: 'Записи календаря',
        icon: Calendar,
        mapRow: (row: LinkedSlotRow) => ({
          id: row.id,
          primary: fmtDateTime(row.startAt),
          secondary: row.lift ? row.lift.name : undefined,
          badge: {
            label: SLOT_STATUS_LABELS[row.status],
            className:
              row.status === 'BOOKED'
                ? 'bg-info-subtle text-info-text'
                : row.status === 'BLOCKED'
                  ? 'bg-destructive-subtle text-destructive'
                  : 'bg-success-subtle text-success',
          },
          preview: {
            title: 'Запис у календарі',
            rows: [
              { label: 'Початок', value: fmtDateTime(row.startAt) },
              { label: 'Кінець', value: fmtDateTime(row.endAt) },
              { label: 'Статус', value: SLOT_STATUS_LABELS[row.status] },
              ...(row.lift ? [{ label: 'Підйомник', value: row.lift.name }] : []),
              ...(row.notes ? [{ label: 'Примітка', value: row.notes }] : []),
            ],
          },
          navigate: () => nav.toCalendarDay(row.startAt),
        }),
      },
      {
        key: 'warranties',
        title: 'Гарантії',
        icon: Shield,
        mapRow: (row: LinkedWarrantyRow) => {
          const isExpired = new Date(row.expiresAt) < new Date();
          return {
            id: row.id,
            primary: row.description || i18n.t('common:linkedDocuments.warranty'),
            secondary: `Дійсна до ${fmtDate(row.expiresAt)}`,
            badge: row.claimedAt
              ? { label: 'Звернення', className: 'bg-warning-subtle text-warning' }
              : undefined,
            preview: {
              title: 'Гарантія',
              rows: [
                {
                  label: 'Дійсна до',
                  value: `${fmtDate(row.expiresAt)}${isExpired ? ' (прострочена)' : ''}`,
                },
                { label: 'Виписано', value: fmtDate(row.createdAt) },
                ...(row.claimedAt ? [{ label: 'Звернення', value: fmtDate(row.claimedAt) }] : []),
                ...(row.description ? [{ label: 'Опис', value: row.description }] : []),
              ],
            },
            navigate: canOpenWarranties ? () => nav.toWarranty(row.id) : undefined,
          };
        },
      },
      purchaseListSection(nav),
    ],
  };
}

// ─── Invoice config ────────────────────────────────────────

/** Позначка фіскального чека в рядку оплати (null → чек не застосовний). */
function fiscalBadge(status: string | null | undefined) {
  if (!status) return undefined;
  const className =
    status === 'DONE'
      ? 'bg-success-subtle text-success'
      : status === 'FAILED'
        ? 'bg-destructive-subtle text-destructive'
        : 'bg-secondary text-muted-foreground';
  return { label: `Чек: ${fiscalStatusLabel(status)}`, className };
}

export interface InvoiceLinkedOptions {
  /**
   * POST /payments/:id/retry-fiscal. Передавати лише ролям, яким це дозволяє контролер
   * (OWNER/ADMIN/ACCOUNTANT) — без нього «Повторити» у рядку не показується.
   */
  retryFiscal?: (paymentId: string) => Promise<unknown>;
}

export function invoiceLinkedConfig(
  nav: LinkedNav,
  opts: InvoiceLinkedOptions = {},
): LinkedEntityConfig {
  return {
    fetchPath: id => `/invoices/${id}/linked-documents`,
    sections: [
      workOrderSection(nav),
      {
        key: 'payments',
        title: 'Оплати',
        icon: CreditCard,
        mapRow: (row: LinkedPaymentRow) => ({
          id: row.id,
          primary: fmtPaymentAmount(row),
          secondary: fmtDateTime(row.createdAt),
          // Сторнована оплата: позначка «Сторновано» замість чека й без «Повторити» — чек
          // сторнованої оплати сервер скасовує, повтор лише отримав би відмову.
          badge: row.reversedAt ? REVERSED_PAYMENT_BADGE : fiscalBadge(row.fiscalStatus),
          action:
            opts.retryFiscal && row.fiscalStatus === 'FAILED' && !row.reversedAt
              ? { label: 'Повторити', run: () => opts.retryFiscal!(row.id) }
              : undefined,
          ...paymentReversalFields(row),
          preview: {
            title: 'Оплата',
            rows: [
              { label: 'Сума', value: fmtPaymentAmount(row) },
              { label: 'Метод', value: METHOD_LABELS[row.method] ?? row.method },
              { label: 'Дата', value: fmtDateTime(row.createdAt) },
              ...(row.fiscalStatus
                ? [{ label: 'Чек', value: fiscalStatusLabel(row.fiscalStatus) }]
                : []),
              ...reversedPreviewRows(row),
              ...(row.notes ? [{ label: 'Примітка', value: row.notes }] : []),
            ],
          },
          // Оплата — рядок без переходу: окремих сторінок оплат немає, готівкові видно в касі.
        }),
      },
      counterpartySection(nav),
    ],
  };
}

// ─── PurchaseOrder config ──────────────────────────────────

/**
 * Секція «Оплати постачальнику» — рядки без переходу: сторінки оплат постачальникам немає,
 * проведені готівкові оплати видно в касі, а саму оплату — у прев'ю рядка.
 */
function supplierPaymentSection({ withDate = true }: { withDate?: boolean } = {}) {
  return {
    key: 'supplierPayments',
    title: 'Оплати постачальнику',
    icon: Wallet,
    mapRow: (row: LinkedSupplierPaymentRow) => ({
      id: row.id,
      primary: `${row.number} — ${fmtPaymentAmount(row)}`,
      secondary: row.documentDate ? fmtDate(row.documentDate) : undefined,
      // Колір — зі спільної мапи статусів: «Сторновано» (REVERSED) має бути помітним, а не
      // сірим, як інші рядки.
      badge: {
        label: supplierPaymentStatusLabel(row.status),
        variant: SUPPLIER_PAYMENT_STATUS_BADGE[row.status] ?? 'secondary',
      },
      preview: {
        title: `Оплата ${row.number}`,
        rows: [
          { label: 'Статус', value: supplierPaymentStatusLabel(row.status) },
          { label: 'Сума', value: fmtPaymentAmount(row) },
          { label: 'Метод', value: METHOD_LABELS[row.method] ?? row.method },
          ...(withDate && row.documentDate
            ? [{ label: 'Дата', value: fmtDate(row.documentDate) }]
            : []),
        ],
      },
    }),
  };
}

export function purchaseOrderLinkedConfig(nav: LinkedNav): LinkedEntityConfig {
  return {
    fetchPath: id => `/purchase-orders/${id}/linked-documents`,
    sections: [supplierPaymentSection(), counterpartySection(nav), purchaseListSection(nav)],
  };
}

// ─── Counterparty config ───────────────────────────────────
// Документи, у яких фігурує контрагент: рахунки / замовлення / оплати / повернення.

interface LinkedSupplierReturnRow {
  id: string;
  number: string;
  status: string;
  totalAmount: string | number;
  documentDate: string | null;
}

// ─── StockDocument / SupplierReturn shared section-builders ─

/** Секція «Замовлення постачальнику» — джерело документа (RECEIPT/OPENING/повернення).
 * key/icon параметризовані: більшість конфігів беруть FK-single `purchaseOrder`
 * з ClipboardList; картка контрагента показує список `purchaseOrders` з ShoppingCart. */
function purchaseOrderSourceSection(
  nav: LinkedNav,
  {
    key = 'purchaseOrder',
    icon = ClipboardList,
    canOpen = true,
  }: { key?: string; icon?: typeof ClipboardList; canOpen?: boolean } = {},
) {
  const amount = (row: LinkedPurchaseOrderRow) =>
    row.totalAmount == null ? null : `${fmt(row.totalAmount)} ${row.currencySymbol || '₴'}`;
  return {
    key,
    title: 'Замовлення постачальнику',
    icon,
    mapRow: (row: LinkedPurchaseOrderRow) => ({
      id: row.id,
      primary: `Замовлення ${row.number}`,
      secondary: amount(row) ?? undefined,
      badge: {
        label: poStatusLabel(row.status),
        className: 'bg-secondary text-muted-foreground',
      },
      preview: {
        title: `Замовлення ${row.number}`,
        rows: [
          { label: 'Статус', value: poStatusLabel(row.status) },
          ...(amount(row) ? [{ label: 'Сума', value: amount(row) }] : []),
        ],
      },
      // Приймальні картка замовлення закрита (`GET /purchase-orders/:id` — 403, Bug #914).
      navigate: canOpen ? () => nav.toPurchaseOrder(row.id) : undefined,
    }),
  };
}

interface LinkedWarehouseRow {
  id: string;
  name: string;
}

/** Секція «Склад(и)» — довідник, без власної сторінки → read-only preview.
 * key/title параметризовані: stock-document має 1-2 склади в секції «Склади»,
 * supplier-return — один «Склад». mapRow однаковий. */
function warehouseSection({
  key = 'warehouse',
  title = i18n.t('common:linkedDocuments.warehouse'),
}: { key?: string; title?: string } = {}) {
  return {
    key,
    title,
    icon: Warehouse,
    mapRow: (row: LinkedWarehouseRow) => ({
      id: row.id,
      primary: row.name,
      preview: { title: row.name, rows: [] },
    }),
  };
}

// ─── StockDocument config ──────────────────────────────────
// warehouses[] — 1 (джерело) або 2 (джерело+ціль для TRANSFER) рядки одної секції.

export function stockDocumentLinkedConfig(nav: LinkedNav): LinkedEntityConfig {
  return {
    fetchPath: id => `/stock-documents/${id}/linked-documents`,
    sections: [
      purchaseOrderSourceSection(nav),
      warehouseSection({ key: 'warehouses', title: 'Склади' }),
    ],
  };
}

// ─── SupplierReturn config ─────────────────────────────────

export function supplierReturnLinkedConfig(nav: LinkedNav): LinkedEntityConfig {
  return {
    fetchPath: id => `/supplier-returns/${id}/linked-documents`,
    sections: [purchaseOrderSourceSection(nav), counterpartySection(nav), warehouseSection()],
  };
}

export function counterpartyLinkedConfig(nav: LinkedNav): LinkedEntityConfig {
  return {
    fetchPath: id => `/counterparties/${id}/linked-documents`,
    sections: [
      invoiceSection(nav, { secondaryField: 'amount' }),
      purchaseOrderSourceSection(nav, { key: 'purchaseOrders', icon: ShoppingCart }),
      supplierPaymentSection({ withDate: false }),
      {
        key: 'supplierReturns',
        title: 'Повернення постачальнику',
        icon: RotateCcw,
        mapRow: (row: LinkedSupplierReturnRow) => ({
          id: row.id,
          primary: `Повернення ${row.number}`,
          secondary: `${fmt(row.totalAmount)} ₴`,
          badge: {
            label: supplierReturnStatusLabel(row.status),
            className: 'bg-secondary text-muted-foreground',
          },
          preview: {
            title: `Повернення ${row.number}`,
            rows: [
              { label: 'Статус', value: supplierReturnStatusLabel(row.status) },
              { label: 'Сума', value: `${fmt(row.totalAmount)} ₴` },
              ...(row.documentDate ? [{ label: 'Дата', value: fmtDate(row.documentDate) }] : []),
            ],
          },
          navigate: () => nav.toSupplierReturn(row.id),
        }),
      },
    ],
  };
}

// ─── Purchase list config ──────────────────────────────────
// Картка списку купівлі, вкладка «Документи» (BR-PL-020): наряди й замовлення постачальнику його
// позицій, списки, обʼєднані в нього. Ключі секцій — як у `GET /purchase-lists/:id/linked-documents`.

export function purchaseListLinkedConfig(
  nav: LinkedNav,
  { canOpenPurchaseOrders = true }: { canOpenPurchaseOrders?: boolean } = {},
): LinkedEntityConfig {
  return {
    fetchPath: id => `/purchase-lists/${id}/linked-documents`,
    sections: [
      workOrderSection(nav, {
        key: 'workOrders',
        title: i18n.t('purchaseLists:documents.workOrders'),
      }),
      purchaseOrderSourceSection(nav, {
        key: 'purchaseOrders',
        icon: ShoppingCart,
        canOpen: canOpenPurchaseOrders,
      }),
      purchaseListSection(nav, { title: i18n.t('purchaseLists:documents.mergedLists') }),
    ],
  };
}
