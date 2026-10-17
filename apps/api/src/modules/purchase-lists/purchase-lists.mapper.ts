import type { Prisma } from '@prisma/client';
import { formatPersonName } from '@sto/shared';
import type { PurchaseListItemResponseDto, PurchaseListResponseDto } from './purchase-lists.dto';

/** Зв'язки позиції для відповіді — одна форма для всіх маршрутів (без дрейфу include). */
export const ITEM_INCLUDE = {
  list: { select: { number: true, status: true } },
  good: { select: { name: true, sku: true, internalCode: true, unit: true } },
  warehouse: { select: { name: true } },
  workOrder: { select: { number: true, status: true } },
  supplier: { select: { firstName: true, lastName: true, companyName: true } },
  purchaseOrder: { select: { number: true, status: true } },
} as const satisfies Prisma.PurchaseListItemInclude;

export type ItemWithRelations = Prisma.PurchaseListItemGetPayload<{
  include: typeof ITEM_INCLUDE;
}>;

export const LIST_INCLUDE = {
  warehouse: { select: { name: true } },
  mergedInto: { select: { number: true } },
} as const satisfies Prisma.PurchaseListInclude;

export type ListWithRelations = Prisma.PurchaseListGetPayload<{ include: typeof LIST_INCLUDE }>;

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);

export function toItemDto(i: ItemWithRelations): PurchaseListItemResponseDto {
  return {
    id: i.id,
    listId: i.listId,
    listNumber: i.list.number,
    listStatus: i.list.status,
    goodId: i.goodId,
    goodName: i.good.name,
    goodSku: i.good.sku ?? null,
    goodCode: i.good.internalCode ?? null,
    goodUnit: i.good.unit ?? null,
    warehouseId: i.warehouseId,
    warehouseName: i.warehouse.name,
    quantity: i.quantity,
    receivedQty: i.receivedQty,
    reservedQty: i.reservedQty,
    status: i.status,
    source: i.source,
    workOrderId: i.workOrderId,
    workOrderNumber: i.workOrder?.number ?? null,
    workOrderStatus: i.workOrder?.status ?? null,
    workOrderPartId: i.workOrderPartId,
    supplierId: i.supplierId,
    supplierName: i.supplier
      ? formatPersonName(i.supplier.lastName, i.supplier.firstName, i.supplier.companyName)
      : null,
    expectedPrice: i.expectedPrice == null ? null : Number(i.expectedPrice),
    purchaseOrderId: i.purchaseOrderId,
    purchaseOrderNumber: i.purchaseOrder?.number ?? null,
    purchaseOrderStatus: i.purchaseOrder?.status ?? null,
    notes: i.notes,
    createdAt: iso(i.createdAt),
  };
}

/**
 * §2.1: очікувана ціна позиції — закупівельна ціна, фінансово чутливе поле. Бачать її ті самі ролі,
 * що й `Good.purchasePrice` (goods.service), — приймальня й механік, яким відкрито перегляд позицій
 * (BR-PL-015), отримують `null`. Невідома роль — теж `null` (fail-closed).
 */
const COST_VISIBLE_ROLES: ReadonlySet<string> = new Set([
  'OWNER',
  'ADMIN',
  'STOREKEEPER',
  'ACCOUNTANT',
]);

export function maskItemCost(
  items: PurchaseListItemResponseDto[],
  role: string | undefined,
): PurchaseListItemResponseDto[] {
  if (role && COST_VISIBLE_ROLES.has(role)) return items;
  return items.map(i => (i.expectedPrice === null ? i : { ...i, expectedPrice: null }));
}

/** Лічильники позицій списку за статусами (з `groupBy`). */
export interface ListCounts {
  open: number;
  ordered: number;
  received: number;
}

export function toListDto(
  l: ListWithRelations,
  counts: ListCounts = { open: 0, ordered: 0, received: 0 },
): PurchaseListResponseDto {
  return {
    id: l.id,
    number: l.number,
    name: l.name,
    status: l.status,
    warehouseId: l.warehouseId,
    warehouseName: l.warehouse?.name ?? null,
    notes: l.notes,
    mergedIntoId: l.mergedIntoId,
    mergedIntoNumber: l.mergedInto?.number ?? null,
    closedAt: l.closedAt ? iso(l.closedAt) : null,
    createdAt: iso(l.createdAt),
    itemsCount: counts.open + counts.ordered + counts.received,
    openCount: counts.open,
    orderedCount: counts.ordered,
    receivedCount: counts.received,
  };
}
