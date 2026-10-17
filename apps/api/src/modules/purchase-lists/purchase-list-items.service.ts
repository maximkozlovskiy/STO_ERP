import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, PurchaseListItem } from '@prisma/client';
import {
  TRANSACTION_TIMEOUT_MS,
  type PurchaseListItemIdsValues,
  type PurchaseListItemSplitValues,
  type PurchaseListItemsBulkUpdateValues,
  type PurchaseListItemsMoveValues,
  type PurchaseListItemUpdateValues,
} from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { buildSortOrderBy, calculatePagination } from '../../common/utils/pagination';
import { escapeLike } from '../../common/utils/like-pattern';
import { DocumentNumberService } from '../document-number/document-number.service';
import { InventoryService } from '../inventory/inventory.service';
import {
  lockWorkOrdersForUpdate,
  netReservedByWorkOrder,
  QTY_EPSILON,
  stockKey,
} from '../work-orders/work-order-stock-requirements';
import { PurchaseShortageService } from './purchase-shortage.service';
import { assertSupplier, conflict, err, loadItemDtos, loadList } from './purchase-lists.helpers';
import { ITEM_INCLUDE, maskItemCost, toItemDto } from './purchase-lists.mapper';
import type {
  BulkResultDto,
  PaginatedPurchaseListItemsDto,
  PurchaseListItemQueryDto,
  PurchaseListItemResponseDto,
  ReleaseReservationResultDto,
  WorkOrderProcurementDto,
} from './purchase-lists.dto';

type Tx = Prisma.TransactionClient;

const ITEM_SORT_FIELDS: Record<string, string> = { createdAt: 'createdAt', quantity: 'quantity' };

/** Умова «позицію ще можна змінювати» (BR-PL-005): OPEN, без замовлення, не видалена. */
const OPEN_ITEM = { status: 'OPEN' as const, purchaseOrderId: null, deletedAt: null };

/**
 * Позиції списків купівлі: перелік, позиції наряду для його картки, зміна OPEN-позицій
 * (BR-PL-005), перенесення й розділення (BR-PL-007), масові дії, «Зняти резерв» (BR-PL-016).
 */
@Injectable()
export class PurchaseListItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly docNumbers: DocumentNumberService,
    private readonly inventory: InventoryService,
    private readonly shortage: PurchaseShortageService,
  ) {}

  async findAll(
    orgId: string,
    query: PurchaseListItemQueryDto,
    role?: string,
  ): Promise<PaginatedPurchaseListItemsDto> {
    const where: Prisma.PurchaseListItemWhereInput = {
      orgId,
      deletedAt: null,
      list: { deletedAt: null },
    };
    if (query.status) where.status = query.status;
    if (query.supplierId === 'none') where.supplierId = null;
    else if (query.supplierId) where.supplierId = query.supplierId;
    if (query.warehouseId) where.warehouseId = query.warehouseId;
    if (query.workOrderId) where.workOrderId = query.workOrderId;
    if (query.listId) where.listId = query.listId;
    const search = query.q?.trim().slice(0, 100);
    if (search) {
      const contains = { contains: escapeLike(search), mode: 'insensitive' as const };
      where.good = { OR: [{ name: contains }, { sku: contains }, { internalCode: contains }] };
    }
    const { skip, take } = calculatePagination({ page: query.page, limit: query.limit });
    const orderBy = buildSortOrderBy(ITEM_SORT_FIELDS, query.sortBy, query.sortDir, 'createdAt');
    const [rows, total] = await Promise.all([
      this.prisma.purchaseListItem.findMany({
        where,
        include: ITEM_INCLUDE,
        orderBy,
        skip,
        take,
      }),
      this.prisma.purchaseListItem.count({ where }),
    ]);
    return {
      items: maskItemCost(rows.map(toItemDto), role),
      total,
      page: query.page,
      limit: take,
    };
  }

  /** Позиції наряду (крім скасованих) і нестача кожного його рядка — для картки наряду. */
  async byWorkOrder(
    orgId: string,
    workOrderId: string,
    role?: string,
  ): Promise<WorkOrderProcurementDto> {
    const itemsWhere = { orgId, deletedAt: null, status: { not: 'CANCELLED' as const } };
    // sto-optimize: картку наряду відкривають часто, а позицій списків у більшості нарядів немає.
    // `findMany` з `include` і на порожньому результаті шле запит на КОЖЕН зв'язок (`IN (NULL)`),
    // тож лічильник позицій береться разом із перевіркою наряду, і порожній список не читається.
    // Нестача рахується паралельно з перевіркою (для чужого/видаленого наряду — 404, як і раніше).
    const [wo, uncovered] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { id: true, _count: { select: { purchaseListItems: { where: itemsWhere } } } },
      }),
      this.shortage.uncoveredRowsByPart(this.prisma, orgId, workOrderId),
    ]);
    if (!wo) throw new NotFoundException(err('err.purchaseList.workOrderNotFound'));
    const rows =
      wo._count.purchaseListItems === 0
        ? []
        : await this.prisma.purchaseListItem.findMany({
            where: { ...itemsWhere, workOrderId },
            include: ITEM_INCLUDE,
            orderBy: { createdAt: 'asc' },
            take: 500,
          });
    return {
      items: maskItemCost(rows.map(toItemDto), role),
      shortage: Array.from(uncovered, ([workOrderPartId, row]) => ({
        workOrderPartId,
        shortage: row.shortage,
        goodUnit: row.goodUnit,
      })),
    };
  }

  /** BR-PL-005: кількість, постачальник, очікувана ціна, примітка — лише OPEN-позиції. */
  async update(
    orgId: string,
    id: string,
    dto: PurchaseListItemUpdateValues,
  ): Promise<PurchaseListItemResponseDto> {
    const item = await this.loadOpenItem(orgId, id);
    if (dto.supplierId) await assertSupplier(this.prisma, orgId, dto.supplierId);
    const res = await this.prisma.purchaseListItem.updateMany({
      where: { id, orgId, ...OPEN_ITEM, quantity: item.quantity },
      data: {
        ...(dto.quantity !== undefined ? { quantity: dto.quantity } : {}),
        ...(dto.supplierId !== undefined ? { supplierId: dto.supplierId } : {}),
        ...(dto.expectedPrice !== undefined ? { expectedPrice: dto.expectedPrice } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });
    if (res.count !== 1) throw conflict();
    const [dtoOut] = await loadItemDtos(this.prisma, orgId, [id]);
    return dtoOut;
  }

  /** BR-PL-007: `0 < кількість < quantity` → нова OPEN-позиція з тими самими зв'язками. */
  async split(
    orgId: string,
    id: string,
    dto: PurchaseListItemSplitValues,
  ): Promise<PurchaseListItemResponseDto[]> {
    const item = await this.loadOpenItem(orgId, id);
    if (dto.quantity <= QTY_EPSILON || dto.quantity >= item.quantity - QTY_EPSILON) {
      throw new BadRequestException(err('err.purchaseList.splitQuantityInvalid'));
    }
    const newId = await this.prisma.$transaction(
      async tx => {
        const res = await tx.purchaseListItem.updateMany({
          where: { id, orgId, ...OPEN_ITEM, quantity: item.quantity },
          data: { quantity: item.quantity - dto.quantity },
        });
        if (res.count !== 1) throw conflict();
        const created = await tx.purchaseListItem.create({
          data: {
            orgId,
            listId: item.listId,
            goodId: item.goodId,
            warehouseId: item.warehouseId,
            quantity: dto.quantity,
            source: item.source,
            workOrderId: item.workOrderId,
            workOrderPartId: item.workOrderPartId,
            supplierId: item.supplierId,
            expectedPrice: item.expectedPrice,
            notes: item.notes,
          },
          select: { id: true },
        });
        return created.id;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return loadItemDtos(this.prisma, orgId, [id, newId]);
  }

  /** BR-PL-007: OPEN-позиції → наявний OPEN-список або новий (`newListName`). */
  async move(orgId: string, dto: PurchaseListItemsMoveValues): Promise<BulkResultDto> {
    const ids = Array.from(new Set(dto.itemIds));
    const items = await this.loadOpenItems(this.prisma, orgId, ids);
    if (dto.targetListId) {
      await loadList(this.prisma, orgId, dto.targetListId, { requireOpen: true });
      if (items.some(i => i.listId === dto.targetListId)) {
        throw new BadRequestException(err('err.purchaseList.moveToSameList'));
      }
    }
    const newNumber = dto.targetListId ? null : await this.docNumbers.next(orgId, 'PURCHASE_LIST');
    await this.prisma.$transaction(
      async tx => {
        const targetId = dto.targetListId
          ? (await loadList(tx, orgId, dto.targetListId, { requireOpen: true })).id
          : (
              await tx.purchaseList.create({
                data: { orgId, number: newNumber as string, name: dto.newListName ?? null },
              })
            ).id;
        const res = await tx.purchaseListItem.updateMany({
          where: { orgId, id: { in: ids }, ...OPEN_ITEM },
          data: { listId: targetId },
        });
        if (res.count !== ids.length) throw conflict();
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return { count: ids.length };
  }

  /** Масово: постачальник і/або очікувана ціна OPEN-позицій (BR-PL-005). */
  async bulkUpdate(orgId: string, dto: PurchaseListItemsBulkUpdateValues): Promise<BulkResultDto> {
    const ids = Array.from(new Set(dto.itemIds));
    await this.loadOpenItems(this.prisma, orgId, ids);
    if (dto.supplierId) await assertSupplier(this.prisma, orgId, dto.supplierId);
    await this.prisma.$transaction(
      async tx => {
        const res = await tx.purchaseListItem.updateMany({
          where: { orgId, id: { in: ids }, ...OPEN_ITEM },
          data: {
            ...(dto.supplierId !== undefined ? { supplierId: dto.supplierId } : {}),
            ...(dto.expectedPrice !== undefined ? { expectedPrice: dto.expectedPrice } : {}),
          },
        });
        if (res.count !== ids.length) throw conflict();
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return { count: ids.length };
  }

  /** Масово скасувати OPEN-позиції (BR-PL-005). */
  async bulkCancel(orgId: string, dto: PurchaseListItemIdsValues): Promise<BulkResultDto> {
    const ids = Array.from(new Set(dto.itemIds));
    await this.loadOpenItems(this.prisma, orgId, ids);
    await this.prisma.$transaction(
      async tx => {
        const res = await tx.purchaseListItem.updateMany({
          where: { orgId, id: { in: ids }, ...OPEN_ITEM },
          data: { status: 'CANCELLED' },
        });
        if (res.count !== ids.length) throw conflict();
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return { count: ids.length };
  }

  /**
   * BR-PL-016: «Зняти резерв» — RESERVATION_RELEASE на `min(reservedQty, net-резерв наряду за
   * товаром і складом)`; `reservedQty` позиції зменшується. Нічого не зарезервовано → 400.
   * Наряд блокується першим (порядок «наряд → склад»).
   */
  async releaseReservation(
    orgId: string,
    id: string,
    userId?: string,
  ): Promise<ReleaseReservationResultDto> {
    const released = await this.prisma.$transaction(
      async tx => {
        const item = await tx.purchaseListItem.findFirst({ where: { id, orgId, deletedAt: null } });
        if (!item) throw new NotFoundException(err('err.purchaseList.itemNotFound'));
        if (!item.workOrderId || item.reservedQty <= QTY_EPSILON) {
          throw new BadRequestException(err('err.purchaseList.nothingToRelease'));
        }
        await lockWorkOrdersForUpdate(tx, orgId, [item.workOrderId]);
        const net = await netReservedByWorkOrder(tx, orgId, item.workOrderId);
        const stock = await tx.stockItem.findFirst({
          where: { orgId, goodId: item.goodId, warehouseId: item.warehouseId, deletedAt: null },
          select: { reserved: true },
        });
        const amount = Math.min(
          item.reservedQty,
          Math.max(0, net.get(stockKey(item.goodId, item.warehouseId)) ?? 0),
          stock?.reserved ?? 0,
        );
        if (amount <= QTY_EPSILON) {
          throw new BadRequestException(err('err.purchaseList.nothingToRelease'));
        }
        const res = await tx.purchaseListItem.updateMany({
          where: { id, orgId, deletedAt: null, reservedQty: item.reservedQty },
          data: { reservedQty: Math.max(0, item.reservedQty - amount) },
        });
        if (res.count !== 1) throw conflict();
        await this.inventory.createMovement(
          orgId,
          {
            goodId: item.goodId,
            warehouseId: item.warehouseId,
            type: 'RESERVATION_RELEASE',
            quantity: -amount,
            documentType: 'WorkOrder',
            documentId: item.workOrderId,
            notes: 'Зняття резерву з позиції списку купівлі',
            createdBy: userId,
          },
          tx,
        );
        return amount;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    const [item] = await loadItemDtos(this.prisma, orgId, [id]);
    return { released, item };
  }

  // ─── Допоміжне ────────────────────────────────────────────

  private async loadOpenItem(orgId: string, id: string): Promise<PurchaseListItem> {
    const item = await this.prisma.purchaseListItem.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!item) throw new NotFoundException(err('err.purchaseList.itemNotFound'));
    if (item.status !== 'OPEN' || item.purchaseOrderId !== null) {
      throw new BadRequestException(err('err.purchaseList.itemNotOpen'));
    }
    return item;
  }

  /** Усі позиції існують в організації й OPEN; інакше 404 itemsNotFound / 400 itemNotOpen. */
  private async loadOpenItems(db: Tx, orgId: string, ids: string[]): Promise<PurchaseListItem[]> {
    const items = await db.purchaseListItem.findMany({
      where: { orgId, id: { in: ids }, deletedAt: null },
      take: ids.length,
    });
    if (items.length !== ids.length) {
      const found = new Set(items.map(i => i.id));
      throw new NotFoundException(
        err('err.purchaseList.itemsNotFound', {
          missing: ids.filter(i => !found.has(i)).join(', '),
        }),
      );
    }
    if (items.some(i => i.status !== 'OPEN' || i.purchaseOrderId !== null)) {
      throw new BadRequestException(err('err.purchaseList.itemNotOpen'));
    }
    return items;
  }
}
