import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma, PurchaseList } from '@prisma/client';
import { err } from '../../common/utils/err';
import { assertCounterpartyRole } from '../../common/utils/counterparty-role';
import {
  ITEM_INCLUDE,
  LIST_INCLUDE,
  toItemDto,
  toListDto,
  type ListCounts,
} from './purchase-lists.mapper';
import type { PurchaseListItemResponseDto, PurchaseListResponseDto } from './purchase-lists.dto';

type Db = Prisma.TransactionClient;

export { err };

/** Відкрита позиція: ще не в замовленні й не видалена — лише її можна змінювати (BR-PL-005). */
export const OPEN_ITEM_WHERE = { status: 'OPEN' as const, purchaseOrderId: null, deletedAt: null };

export const isItemOpen = (item: { status: string; purchaseOrderId: string | null }): boolean =>
  item.status === 'OPEN' && item.purchaseOrderId === null;

export const conflict = (): ConflictException =>
  new ConflictException(err('err.purchaseList.concurrentChange'));

/** Список організації, не видалений; `requireOpen` — інакше 400 listNotOpen (BR-PL-005). */
export async function loadList(
  db: Db,
  orgId: string,
  id: string,
  opts: { requireOpen?: boolean } = {},
): Promise<PurchaseList> {
  const list = await db.purchaseList.findFirst({ where: { id, orgId, deletedAt: null } });
  if (!list) throw new NotFoundException(err('err.purchaseList.notFound'));
  if (opts.requireOpen && list.status !== 'OPEN') {
    throw new BadRequestException(err('err.purchaseList.listNotOpen'));
  }
  return list;
}

/** BR-PL-004: постачальник — контрагент організації з роллю постачальника (BR-CP-001). */
export async function assertSupplier(db: Db, orgId: string, supplierId: string): Promise<void> {
  const supplier = await db.counterparty.findFirst({
    where: { id: supplierId, orgId, deletedAt: null },
    select: { type: true },
  });
  if (!supplier) throw new NotFoundException(err('err.purchaseList.supplierNotFound'));
  assertCounterpartyRole(supplier.type, 'supplier');
}

/** Позиції за id у формі відповіді (порядок — як у `ids`). */
export async function loadItemDtos(
  db: Db,
  orgId: string,
  ids: string[],
): Promise<PurchaseListItemResponseDto[]> {
  if (ids.length === 0) return [];
  const rows = await db.purchaseListItem.findMany({
    where: { orgId, id: { in: ids } },
    include: ITEM_INCLUDE,
    take: ids.length,
  });
  const byId = new Map(rows.map(r => [r.id, toItemDto(r)]));
  return ids.map(id => byId.get(id)).filter((d): d is PurchaseListItemResponseDto => !!d);
}

/** Лічильники позицій за статусами для списків (`groupBy`, без N+1). */
export async function listCounts(
  db: Db,
  orgId: string,
  listIds: string[],
): Promise<Map<string, ListCounts>> {
  const result = new Map<string, ListCounts>();
  if (listIds.length === 0) return result;
  const groups = await db.purchaseListItem.groupBy({
    by: ['listId', 'status'],
    where: { orgId, listId: { in: listIds }, deletedAt: null },
    _count: { _all: true },
  });
  for (const g of groups) {
    const c = result.get(g.listId) ?? { open: 0, ordered: 0, received: 0 };
    const n = g._count._all;
    if (g.status === 'OPEN') c.open += n;
    else if (g.status === 'ORDERED') c.ordered += n;
    else if (g.status === 'RECEIVED') c.received += n;
    result.set(g.listId, c);
  }
  return result;
}

export async function loadListDto(
  db: Db,
  orgId: string,
  id: string,
): Promise<PurchaseListResponseDto> {
  const list = await db.purchaseList.findFirst({
    where: { id, orgId, deletedAt: null },
    include: LIST_INCLUDE,
  });
  if (!list) throw new NotFoundException(err('err.purchaseList.notFound'));
  const counts = await listCounts(db, orgId, [id]);
  return toListDto(list, counts.get(id));
}
