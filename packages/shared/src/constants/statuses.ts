/**
 * Shared status/badge/transition constants for all domain entities.
 * Uses string literals (not Prisma enums) — safe for browser bundles.
 * Single source of truth: import from '@sto/shared' everywhere.
 */

export type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'info'
  | 'purple';

// ─── Work Orders ─────────────────────────────────────────────────────────────

export const WO_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка',
  ESTIMATE: 'Кошторис',
  APPROVED: 'Затверджено',
  IN_PROGRESS: 'В роботі',
  ON_HOLD: 'Призупинено',
  COMPLETED: 'Виконано',
  INVOICED: 'Виставлено',
  PAID: 'Оплачено',
  ARCHIVED: 'Архів',
  CANCELLED: 'Скасовано',
};

export const WO_STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary',
  ESTIMATE: 'warning',
  APPROVED: 'default',
  IN_PROGRESS: 'default',
  ON_HOLD: 'warning',
  COMPLETED: 'success',
  INVOICED: 'default',
  PAID: 'success',
  ARCHIVED: 'secondary',
  CANCELLED: 'destructive',
};

// Status sets for business-rule gates. Must mirror backend work-orders.fsm.ts constants.
// Frontend reads these instead of hardcoding inline status arrays.
export const WO_EDITABLE_STATUSES: readonly string[] = Object.freeze([
  'DRAFT',
  'ESTIMATE',
  'APPROVED',
]);
export const WO_SHAREABLE_STATUSES: readonly string[] = Object.freeze([
  'DRAFT',
  'ESTIMATE',
  'APPROVED',
]);
export const WO_INVOICEABLE_STATUSES: readonly string[] = Object.freeze(['COMPLETED', 'INVOICED']);

// Single source of truth: must mirror backend `WORK_ORDER_TRANSITIONS`
// in apps/api/src/modules/work-orders/work-orders.fsm.ts. Backend is authoritative —
// if these diverge the UI offers transitions the API will reject with 400.
export const WO_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ESTIMATE', 'CANCELLED'],
  ESTIMATE: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED'],
  ON_HOLD: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['INVOICED'],
  INVOICED: ['PAID'],
  PAID: ['ARCHIVED'],
  ARCHIVED: [],
  CANCELLED: [],
};

export const WO_PRIORITY_LABELS: Record<string, string> = {
  LOW: 'Низький',
  NORMAL: 'Звичайний',
  HIGH: 'Високий',
  URGENT: 'Терміново',
};

export const WO_PRIORITY_BADGE: Record<string, BadgeVariant> = {
  LOW: 'secondary',
  NORMAL: 'default',
  HIGH: 'warning',
  URGENT: 'destructive',
};

export const WO_CATEGORY_LABELS: Record<string, string> = {
  MAINTENANCE: 'ТО',
  CURRENT_REPAIR: 'Поточний ремонт',
  MAJOR_REPAIR: 'Кап. ремонт',
  BODY_REPAIR: 'Кузовний',
  DIAGNOSTICS: 'Діагностика',
  WARRANTY: 'Гарантійний',
  SEASONAL: 'Сезонне',
};

// ─── Invoices ─────────────────────────────────────────────────────────────────

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка',
  SENT: 'Надіслано',
  PAID: 'Оплачено',
  OVERDUE: 'Прострочено',
  CANCELLED: 'Скасовано',
};

export const INVOICE_STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary',
  SENT: 'default',
  PAID: 'success',
  OVERDUE: 'warning',
  CANCELLED: 'destructive',
};

// Single source of truth: must mirror backend `INV_TRANSITIONS` in
// apps/api/src/modules/invoices/invoices.service.ts.
export const INVOICE_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['PAID', 'CANCELLED'],
  OVERDUE: ['PAID', 'CANCELLED'],
  PAID: [],
  CANCELLED: [],
};

export const INVOICE_TYPE_LABELS: Record<string, string> = {
  STANDARD: 'Стандартний',
  PREPAYMENT: 'Аванс',
  CREDIT_NOTE: 'Кредит-нота',
};

// ─── Purchase Orders ──────────────────────────────────────────────────────────

export const PO_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка',
  ORDERED: 'Замовлено',
  PARTIAL: 'Частково',
  RECEIVED: 'Отримано',
  CANCELLED: 'Скасовано',
};

export const PO_STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary',
  ORDERED: 'default',
  PARTIAL: 'warning',
  RECEIVED: 'success',
  CANCELLED: 'destructive',
};

// Single source of truth: must mirror backend `PO_TRANSITIONS` in
// apps/api/src/modules/purchase-orders/purchase-orders.service.ts.
export const PO_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ORDERED', 'CANCELLED'],
  ORDERED: ['PARTIAL', 'RECEIVED', 'CANCELLED'],
  PARTIAL: ['RECEIVED', 'CANCELLED'],
  RECEIVED: [],
  CANCELLED: [],
};

export const PO_STATUS_ACTION_LABELS: Record<string, string> = {
  ORDERED: 'Підтвердити замовлення',
  RECEIVED: 'Позначити отриманим',
  CANCELLED: 'Скасувати',
  PARTIAL: 'Часткове отримання',
};

// ─── Stock Documents ──────────────────────────────────────────────────────────

export const STOCK_DOC_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка',
  CONFIRMED: 'Підтверджено',
  CANCELLED: 'Скасовано',
};

export const STOCK_DOC_STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary',
  CONFIRMED: 'success',
  CANCELLED: 'destructive',
};

// Single source of truth: must mirror backend `DOC_TRANSITIONS` in
// apps/api/src/modules/stock-documents/stock-documents.service.ts.
export const STOCK_DOC_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: [],
  CANCELLED: [],
};

export const STOCK_DOC_TYPE_LABELS: Record<string, string> = {
  WRITEOFF: 'Списання',
  TRANSFER: 'Переміщення',
  OPENING_BALANCE: 'Поч. залишки',
  RECEIPT: 'Оприбуткування',
};

export const STOCK_DOC_TYPE_BADGE: Record<string, BadgeVariant> = {
  WRITEOFF: 'destructive',
  TRANSFER: 'default',
  OPENING_BALANCE: 'secondary',
  RECEIPT: 'success',
};

// ─── Employees ────────────────────────────────────────────────────────────────

export const EMPLOYEE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Активний',
  ON_LEAVE: 'У відпустці',
  FIRED: 'Звільнений',
};

export const EMPLOYEE_STATUS_BADGE: Record<string, BadgeVariant> = {
  ACTIVE: 'success',
  ON_LEAVE: 'warning',
  FIRED: 'secondary',
};

export const EMPLOYEE_ROLE_LABELS: Record<string, string> = {
  OWNER: 'Власник',
  ADMIN: 'Адміністратор',
  RECEPTIONIST: 'Приймальник',
  MECHANIC: 'Механік',
  STOREKEEPER: 'Комірник',
  ACCOUNTANT: 'Бухгалтер',
  CLIENT: 'Клієнт',
  XLSX_MANAGER: 'Менеджер імпорту',
};

export const EMPLOYEE_ROLE_BADGE: Record<string, BadgeVariant> = {
  OWNER: 'destructive',
  ADMIN: 'default',
  RECEPTIONIST: 'secondary',
  MECHANIC: 'warning',
  STOREKEEPER: 'secondary',
  ACCOUNTANT: 'secondary',
  CLIENT: 'secondary',
  XLSX_MANAGER: 'secondary',
};

// ─── Counterparty ─────────────────────────────────────────────────────────────

export const COUNTERPARTY_TYPE_LABELS: Record<string, string> = {
  CLIENT: 'Клієнт',
  SUPPLIER: 'Постачальник',
  BOTH: 'Обидва',
};

export const COUNTERPARTY_TYPE_BADGE: Record<string, BadgeVariant> = {
  CLIENT: 'default',
  SUPPLIER: 'secondary',
  BOTH: 'warning',
};

export const CONTRACT_TYPE_LABELS: Record<string, string> = {
  PURCHASE: 'Купівля',
  SALE: 'Продаж',
};

// ─── Good ─────────────────────────────────────────────────────────────────────

export const GOOD_TYPE_LABELS: Record<string, string> = {
  SPARE_PART: 'Запчастина',
  CONSUMABLE: 'Витратний матеріал',
  MATERIAL: 'Матеріал',
  TOOL: 'Інструмент',
};

export const GOOD_TYPE_BADGE: Record<string, BadgeVariant> = {
  SPARE_PART: 'default',
  CONSUMABLE: 'secondary',
  MATERIAL: 'warning',
  TOOL: 'success',
};
