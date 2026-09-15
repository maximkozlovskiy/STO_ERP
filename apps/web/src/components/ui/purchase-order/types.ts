// Спільні типи/константи/хелпери модалки замовлення постачальнику (TD3-декомпозиція).
// Винесено з PurchaseOrderCreateModal.tsx без зміни поведінки — module-scope, pure move.
import { PO_STATUS_LABELS } from '@sto/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Warehouse {
  id: string;
  name: string;
  deletedAt?: string | null;
}

export interface Supplier {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  phone?: string | null;
}

export interface Good {
  id: string;
  name: string;
  internalCode?: string | null;
  sku: string | null;
  brandName?: string | null;
  unit: string | null;
  purchasePrice: number | null;
  barcode?: string | null;
  barcodes?: string[];
}

export interface PODetail {
  id: string;
  number: string;
  status: string;
  supplierId: string;
  supplierName?: string | null;
  currencyId?: string | null;
  currencyCode?: string | null;
  warehouseId: string;
  warehouseName?: string | null;
  contractId?: string | null;
  contractNumber?: string | null;
  notes?: string | null;
  documentDate?: string | null;
  paymentDate?: string | null;
  trackingNumber?: string | null;
  lines?: POLine[];
}

export interface LocalLine {
  _key: string;
  id?: string;
  goodId: string;
  goodName: string;
  goodSku?: string | null;
  goodInternalCode?: string | null;
  goodBrandName?: string | null;
  unit: string;
  unitShortName?: string | null;
  quantity: string;
  price: string;
  receivedQty?: number;
  pricedSalePrice?: number | null;
  pricingRuleName?: string | null;
}

export interface POLine {
  id: string;
  goodId: string;
  goodName?: string | null;
  goodSku?: string | null;
  goodInternalCode?: string | null;
  goodBrandName?: string | null;
  unit?: string | null;
  unitShortName?: string | null;
  quantity: number;
  price: number;
  receivedQty?: number;
  pricedSalePrice?: number | null;
  pricingRuleName?: string | null;
}

export interface PricingRule {
  id: string;
  name: string;
  description: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-secondary text-muted-foreground',
  ORDERED: 'bg-primary-subtle text-primary',
  PARTIAL: 'bg-warning-subtle text-warning',
  RECEIVED: 'bg-success-subtle text-success',
  CANCELLED: 'bg-destructive-subtle text-destructive',
};

export const STATUS_DESCRIPTIONS: Record<string, string> = {
  DRAFT: 'Чернетка — замовлення підготовлено, ще не відправлено постачальнику',
  ORDERED: 'Замовлено — замовлення відправлено, очікується постачання',
  PARTIAL: 'Частково отримано — частина товарів вже надійшла',
  RECEIVED: 'Отримано — всі товари оприбутковано',
  CANCELLED: 'Скасовано — замовлення скасовано',
};

export const PO_STATUS_ORDER = Object.keys(PO_STATUS_LABELS);
export const EMPTY_TRANSITIONS: readonly string[] = Object.freeze([]);

export const nextKey = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `k${Math.random().toString(36).slice(2)}`;

export const EMPTY_LINE: Omit<LocalLine, '_key'> = {
  goodId: '',
  goodName: '',
  unit: 'шт',
  quantity: '1',
  price: '',
};
