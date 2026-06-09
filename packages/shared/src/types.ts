// Domain types — розширюватиметься по мірі росту schema.prisma
// Summary types — lightweight interfaces for list views, shared between backend and frontend

export type UUID = string;

export interface BaseEntity {
  id: UUID;
  orgId: UUID;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  syncVersion: bigint;
}

/**
 * @deprecated Use `PaginatedSummary<T>` (with `items` field) — STO ERP canonical list shape
 * per skill §4 ("List endpoints → { items, total }"). Kept only for legacy callers; remove
 * once last consumer is migrated.
 */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface ApiError {
  statusCode: number;
  message: string;
  error?: string;
}

export interface SyncRecord {
  table: string;
  id: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  syncVersion: number;
  payload: Record<string, unknown>;
}

// ─── Status enums (mirror Prisma enums for frontend use) ──────────────────────

export const WorkOrderStatus = {
  DRAFT: 'DRAFT',
  ESTIMATE: 'ESTIMATE',
  APPROVED: 'APPROVED',
  IN_PROGRESS: 'IN_PROGRESS',
  ON_HOLD: 'ON_HOLD',
  COMPLETED: 'COMPLETED',
  INVOICED: 'INVOICED',
  PAID: 'PAID',
  ARCHIVED: 'ARCHIVED',
  CANCELLED: 'CANCELLED',
} as const;
export type WorkOrderStatus = (typeof WorkOrderStatus)[keyof typeof WorkOrderStatus];

export const InvoiceStatus = {
  DRAFT: 'DRAFT',
  SENT: 'SENT',
  PAID: 'PAID',
  OVERDUE: 'OVERDUE',
  CANCELLED: 'CANCELLED',
} as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

export const PurchaseOrderStatus = {
  DRAFT: 'DRAFT',
  ORDERED: 'ORDERED',
  PARTIAL: 'PARTIAL',
  RECEIVED: 'RECEIVED',
  CANCELLED: 'CANCELLED',
} as const;
export type PurchaseOrderStatus = (typeof PurchaseOrderStatus)[keyof typeof PurchaseOrderStatus];

export const CounterpartyType = {
  CLIENT: 'CLIENT',
  SUPPLIER: 'SUPPLIER',
  BOTH: 'BOTH',
} as const;
export type CounterpartyType = (typeof CounterpartyType)[keyof typeof CounterpartyType];

// ─── Summary types for list views ─────────────────────────────────────────────

export interface WorkOrderSummary {
  id: UUID;
  number: string;
  status: WorkOrderStatus;
  totalAmount: number;
  paidAmount: number;
  counterpartyId: string;
  counterpartyName?: string;
  vehicleId?: string | null;
  vehicleSummary?: string | null;
  branchId: string;
  plannedAt?: string | null;
  priority?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface CounterpartySummary {
  id: UUID;
  type: CounterpartyType;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  phone?: string | null;
  email?: string | null;
  edrpou?: string | null;
  vatPayer: boolean;
  balance: number;
  createdAt: string;
  deletedAt?: string | null;
}

export interface InvoiceSummary {
  id: UUID;
  number: string;
  status: InvoiceStatus;
  totalAmount: number;
  counterpartyId: string;
  counterpartyName?: string;
  workOrderId?: string | null;
  dueDate?: string | null;
  createdAt: string;
  deletedAt?: string | null;
}

export interface GoodSummary {
  id: UUID;
  name: string;
  sku?: string | null;
  unit: string;
  salePrice: number;
  purchasePrice?: number | null;
  category?: string | null;
  brandId?: string | null;
  brandName?: string | null;
  deletedAt?: string | null;
}

export interface BranchSummary {
  id: UUID;
  name: string;
  address?: string | null;
  isMain?: boolean;
}

export interface PaginatedSummary<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

// ─── Utility types ─────────────────────────────────────────────────────────────

export function formatPersonName(
  lastName?: string | null,
  firstName?: string | null,
  companyName?: string | null,
): string {
  if (companyName) return companyName;
  return [lastName, firstName].filter(Boolean).join(' ') || '';
}

export function formatVehicleLabel(
  vehicle?: { make: string; model: string; licensePlate?: string | null } | null,
): string {
  if (!vehicle) return '';
  return `${vehicle.make} ${vehicle.model}${vehicle.licensePlate ? ` (${vehicle.licensePlate})` : ''}`;
}
