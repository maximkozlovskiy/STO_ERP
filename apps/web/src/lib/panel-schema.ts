'use client';

/**
 * Schema-driven panel fields — "metadata-driven UI" pattern.
 *
 * Замість хардкоду масивів полів у кожній сторінці:
 *   1. Оголошуємо схему один раз поряд з типом (PanelFieldDef<T>[])
 *   2. buildPanelContent() рендерить всі поля автоматично
 *   3. Порядок і видимість зберігаються в useDetailPanelConfig
 *
 * TypeScript гарантує: `key` завжди існує в типі T завдяки `satisfies`.
 * Мультимовність: label задається тут — одне місце для перекладу.
 */

import type { ReactNode } from 'react';
import type { Invoice } from '@/hooks/api/useInvoices';
import type { WorkOrder } from '@/hooks/api/useWorkOrders';
import type { Work } from '@/hooks/api/useWorks';
import type { PurchaseOrder } from '@/hooks/api/usePurchaseOrders';
import type { StockDoc } from '@/hooks/api/useStockDocuments';
import type { StockItem } from '@/hooks/api/useInventory';
import type { Counterparty } from '@/hooks/api/useCounterparties';
import { fmtMoney, fmtDate, fmtDateTime } from '@/lib/format';

// ─── Core types ───────────────────────────────────────────────────────────────

export type PanelFieldType =
  | 'text' // plain string
  | 'money' // fmtMoney() + ₴
  | 'date' // fmtDate()
  | 'datetime' // fmtDateTime()
  | 'node' // pre-built ReactNode (Badge, etc.) — use render()
  | 'number'; // String(value)

export interface PanelFieldDef<T extends object> {
  /** Must match a key of T — TypeScript enforces this via `satisfies`. */
  key: Extract<keyof T, string>;
  /** Ukrainian label. Single source of truth — edit here for translations. */
  label: string;
  /** How to format the raw value. Default: 'text'. */
  type?: PanelFieldType;
  /**
   * Custom renderer — use when the raw value needs a Badge, color class, etc.
   * When provided, `type` is ignored.
   */
  render?: (value: T[Extract<keyof T, string>], record: T) => ReactNode;
  /**
   * If true — field always shown, cannot be hidden via config.
   * Use for primary identifier fields (status, number).
   */
  always?: boolean;
}

// ─── Runtime helpers ──────────────────────────────────────────────────────────

/** Formats a raw value according to field type. */
function formatValue(value: unknown, type: PanelFieldType = 'text'): ReactNode {
  if (value === null || value === undefined || value === '') return undefined;
  switch (type) {
    case 'money':
      return `${fmtMoney(Number(value))} ₴`;
    case 'date':
      return fmtDate(String(value));
    case 'datetime':
      return fmtDateTime(String(value));
    case 'number':
      return String(value);
    default:
      return String(value);
  }
}

export interface PanelFieldConfig {
  hiddenFields: string[];
  fieldOrder: string[];
}

/**
 * Returns an ordered, visibility-filtered list of rendered fields.
 * Pass the result directly to PanelField components.
 *
 * @param renderOverrides - per-key render overrides: (value, record) => ReactNode.
 *   Use for fields that need Badge, color classes, etc. — keeps schema pure.
 */
export function buildPanelFields<T extends object>(
  record: T,
  schema: readonly PanelFieldDef<T>[],
  config: PanelFieldConfig,
  renderOverrides?: Partial<Record<Extract<keyof T, string>, (v: unknown, r: T) => ReactNode>>,
): Array<{ key: string; label: string; value: ReactNode; hidden: boolean; always: boolean }> {
  // Apply saved order: keys in fieldOrder come first (in that order),
  // then remaining schema keys in original order.
  const ordered = [...schema].sort((a, b) => {
    const ai = config.fieldOrder.indexOf(a.key);
    const bi = config.fieldOrder.indexOf(b.key);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  return ordered.map(def => {
    const raw = record[def.key as keyof T];
    const override = renderOverrides?.[def.key as Extract<keyof T, string>];
    const value: ReactNode = override
      ? override(raw, record)
      : def.render
        ? def.render(raw as T[Extract<keyof T, string>], record)
        : formatValue(raw, def.type);

    return {
      key: def.key,
      label: def.label,
      value,
      hidden: !def.always && config.hiddenFields.includes(def.key),
      always: def.always ?? false,
    };
  });
}

/** Converts schema to PanelConfigField[] for DetailPanel configFields prop. */
export function schemaToPanelConfigFields<T extends object>(
  schema: readonly PanelFieldDef<T>[],
  config: PanelFieldConfig,
): Array<{ key: string; label: string; hidden: boolean }> {
  return buildPanelFields({} as T, schema, config).map(f => ({
    key: f.key,
    label: f.label,
    hidden: f.hidden,
  }));
}

// ─── Schemas ──────────────────────────────────────────────────────────────────
// Each schema uses `satisfies PanelFieldDef<T>[]` so TypeScript validates
// that every `key` exists on the corresponding interface.

export const INVOICE_PANEL_SCHEMA = [
  { key: 'status', label: 'Статус', always: true },
  { key: 'counterpartyName', label: 'Контрагент' },
  { key: 'workOrderNumber', label: 'Наряд' },
  { key: 'invoiceType', label: 'Тип' },
  { key: 'amount', label: 'Сума', type: 'money' },
  { key: 'totalWithoutVat', label: 'Без ПДВ', type: 'money' },
  { key: 'totalVat', label: 'ПДВ', type: 'money' },
  { key: 'totalWithVat', label: 'Разом з ПДВ', type: 'money' },
  { key: 'paidAmount', label: 'Сплачено', type: 'money' },
  { key: 'documentDate', label: 'Дата документа', type: 'date' },
  { key: 'dueDate', label: 'Термін оплати', type: 'date' },
  { key: 'notes', label: 'Нотатки' },
] as const satisfies readonly PanelFieldDef<Invoice>[];

export const WORK_ORDER_PANEL_SCHEMA = [
  { key: 'status', label: 'Статус', always: true },
  { key: 'priority', label: 'Пріоритет' },
  { key: 'repairCategory', label: 'Категорія' },
  { key: 'counterpartyName', label: 'Клієнт' },
  { key: 'vehicleSummary', label: 'Автомобіль' },
  { key: 'totalAmount', label: 'Сума', type: 'money' },
  { key: 'documentDate', label: 'Дата документа', type: 'date' },
  { key: 'dueDate', label: 'Дедлайн', type: 'date' },
  { key: 'plannedAt', label: 'Заплановано', type: 'datetime' },
  { key: 'createdAt', label: 'Створено', type: 'datetime' },
  { key: 'description', label: 'Опис' },
] as const satisfies readonly PanelFieldDef<WorkOrder>[];

export const WORK_PANEL_SCHEMA = [
  { key: 'categoryName', label: 'Категорія' },
  { key: 'normoHours', label: 'Нормо-год', type: 'number' },
  { key: 'price', label: 'Ціна', type: 'money' },
  { key: 'isWarranty', label: 'Гарантійна' },
  { key: 'description', label: 'Опис' },
] as const satisfies readonly PanelFieldDef<Work>[];

export const PURCHASE_ORDER_PANEL_SCHEMA = [
  { key: 'status', label: 'Статус', always: true },
  { key: 'supplierName', label: 'Постачальник' },
  { key: 'warehouseName', label: 'Склад' },
  { key: 'contractNumber', label: 'Договір' },
  { key: 'totalAmount', label: 'Сума', type: 'money' },
  { key: 'linesCount', label: 'Позицій', type: 'number' },
  { key: 'documentDate', label: 'Дата документа', type: 'date' },
  { key: 'notes', label: 'Нотатки' },
  { key: 'createdAt', label: 'Дата', type: 'date' },
] as const satisfies readonly PanelFieldDef<PurchaseOrder>[];

export const STOCK_DOC_PANEL_SCHEMA = [
  { key: 'type', label: 'Тип', always: true },
  { key: 'status', label: 'Статус', always: true },
  { key: 'warehouseName', label: 'Склад-джерело' },
  { key: 'targetWarehouseName', label: 'Склад-призначення' },
  { key: 'branchName', label: 'Філія' },
  { key: 'documentDate', label: 'Дата документа', type: 'date' },
  { key: 'confirmedAt', label: 'Підтверджено', type: 'date' },
  { key: 'notes', label: 'Нотатки' },
] as const satisfies readonly PanelFieldDef<StockDoc>[];

export const STOCK_ITEM_PANEL_SCHEMA = [
  { key: 'goodSku', label: 'Артикул (SKU)' },
  { key: 'warehouseName', label: 'Склад' },
  { key: 'quantity', label: 'Кількість', type: 'number' },
  { key: 'reserved', label: 'Резерв', type: 'number' },
  { key: 'available', label: 'Доступно', type: 'number' },
  { key: 'salePrice', label: 'Ціна продажу', type: 'money' },
  { key: 'minStock', label: 'Мін. залишок', type: 'number' },
] as const satisfies readonly PanelFieldDef<StockItem>[];

// Service is defined inline in ServicesTab — schema lives here for consistency.
interface ServiceForSchema {
  price: number | null;
  description: string | null;
}
export const SERVICE_PANEL_SCHEMA = [
  { key: 'price', label: 'Ціна', type: 'money' },
  { key: 'description', label: 'Опис' },
] as const satisfies readonly PanelFieldDef<ServiceForSchema>[];

// CRM (Counterparty) panel — basic info tab fields.
// type/balance rendered via renderOverrides in crm/page.tsx.
export const COUNTERPARTY_PANEL_SCHEMA = [
  { key: 'type', label: 'Тип контрагента', always: true },
  { key: 'phone', label: 'Телефон' },
  { key: 'email', label: 'Email' },
  { key: 'edrpou', label: 'ЄДРПОУ' },
  { key: 'balance', label: 'Баланс', type: 'money' },
  { key: 'contactPerson', label: 'Контактна особа' },
] as const satisfies readonly PanelFieldDef<Counterparty>[];

// Employee panel — info tab fields.
// status/role/rateScheme rendered via renderOverrides in employees/page.tsx.
interface EmployeeForSchema {
  status: string;
  role: string;
  phone: string | null;
  email?: string | null;
  dateOfHire?: string | null;
  dateOfFire?: string | null;
}
export const EMPLOYEE_PANEL_SCHEMA = [
  { key: 'status', label: 'Статус', always: true },
  { key: 'role', label: 'Посада' },
  { key: 'phone', label: 'Телефон' },
  { key: 'email', label: 'Email' },
  { key: 'dateOfHire', label: 'Дата прийняття', type: 'date' },
  { key: 'dateOfFire', label: 'Дата звільнення', type: 'date' },
] as const satisfies readonly PanelFieldDef<EmployeeForSchema>[];
