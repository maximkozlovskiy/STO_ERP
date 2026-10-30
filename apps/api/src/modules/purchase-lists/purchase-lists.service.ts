import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  TRANSACTION_TIMEOUT_MS,
  type PurchaseListCreateValues,
  type PurchaseListFromWorkOrderValues,
  type PurchaseListManualItemValues,
  type PurchaseListMergeValues,
  type PurchaseListUpdateValues,
} from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { calculatePagination } from '../../common/utils/pagination';
import { escapeLike } from '../../common/utils/like-pattern';
import { initCountsMap } from '../../common/utils/linked-counts';
import { DocumentNumberService } from '../document-number/document-number.service';
import { lockWorkOrdersForUpdate, QTY_EPSILON } from '../work-orders/work-order-stock-requirements';
import { PROCUREMENT_ACTIVE_STATUSES } from '../work-orders/work-orders.fsm';
import { PurchaseShortageService } from './purchase-shortage.service';
import { setItemQuantity } from './purchase-list-offer-snapshot';
import {
  assertSupplier,
  conflict,
  err,
  listCounts,
  loadItemDtos,
  loadList,
  loadListDto,
  OPEN_ITEM_WHERE,
} from './purchase-lists.helpers';
import {
  canSeeItemCost,
  ITEM_INCLUDE,
  LIST_INCLUDE,
  maskItemCost,
  toItemDto,
  toListDto,
} from './purchase-lists.mapper';
import type {
  FromWorkOrderResultDto,
  PaginatedPurchaseListsDto,
  PurchaseListDetailDto,
  PurchaseListItemResponseDto,
  PurchaseListLinkedDocumentsDto,
  PurchaseListQueryDto,
  PurchaseListResponseDto,
} from './purchase-lists.dto';

type Tx = Prisma.TransactionClient;

/** OPEN-позиція рядка наряду в цільовому списку: id і кількість для CAS-збільшення. */
interface OpenItemRef {
  id: string;
  quantity: number;
  offerMultiplicity: number | null;
}

/**
 * Списки купівлі (docs/objects/purchase-list.md): перелік, створення, надсилання з наряду (BR-PL-003),
 * ручні позиції (BR-PL-004), об'єднання (BR-PL-006), закриття, скасування, видалення, зв'язки.
 * Операції з окремими позиціями — PurchaseListItemsService; замовлення зі списку —
 * PurchaseListOrdersService.
 */
@Injectable()
export class PurchaseListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly docNumbers: DocumentNumberService,
    private readonly shortage: PurchaseShortageService,
  ) {}

  async findAll(orgId: string, query: PurchaseListQueryDto): Promise<PaginatedPurchaseListsDto> {
    const where: Prisma.PurchaseListWhereInput = { orgId, deletedAt: null };
    if (query.status) where.status = query.status;
    const search = query.q?.trim().slice(0, 100);
    if (search) {
      const contains = { contains: escapeLike(search), mode: 'insensitive' as const };
      where.OR = [{ number: contains }, { name: contains }];
    }
    const { skip, take } = calculatePagination({ page: query.page, limit: query.limit });
    const [lists, total] = await Promise.all([
      this.prisma.purchaseList.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.purchaseList.count({ where }),
    ]);
    const counts = await listCounts(
      this.prisma,
      orgId,
      lists.map(l => l.id),
    );
    return {
      items: lists.map(l => toListDto(l, counts.get(l.id))),
      total,
      page: query.page,
      limit: take,
    };
  }

  async findOne(orgId: string, id: string, role?: string): Promise<PurchaseListDetailDto> {
    const [list, items] = await Promise.all([
      loadListDto(this.prisma, orgId, id),
      this.prisma.purchaseListItem.findMany({
        where: { orgId, listId: id, deletedAt: null },
        include: ITEM_INCLUDE,
        orderBy: { createdAt: 'asc' },
        take: 1000,
      }),
    ]);
    return { ...list, items: maskItemCost(items.map(toItemDto), role) };
  }

  /** BR-PL-001: номер береться ДО транзакції (пропуск номера при відмові допустимий). */
  async create(orgId: string, dto: PurchaseListCreateValues): Promise<PurchaseListResponseDto> {
    if (dto.warehouseId) await this.assertWarehouse(orgId, dto.warehouseId);
    const number = await this.docNumbers.next(orgId, 'PURCHASE_LIST');
    const list = await this.prisma.purchaseList.create({
      data: {
        orgId,
        number,
        name: dto.name ?? null,
        warehouseId: dto.warehouseId ?? null,
        notes: dto.notes ?? null,
      },
    });
    return loadListDto(this.prisma, orgId, list.id);
  }

  async update(
    orgId: string,
    id: string,
    dto: PurchaseListUpdateValues,
  ): Promise<PurchaseListResponseDto> {
    const list = await loadList(this.prisma, orgId, id, { requireOpen: true });
    if (dto.warehouseId) await this.assertWarehouse(orgId, dto.warehouseId);
    const res = await this.prisma.purchaseList.updateMany({
      where: { id, orgId, deletedAt: null, status: 'OPEN', updatedAt: list.updatedAt },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.warehouseId !== undefined ? { warehouseId: dto.warehouseId } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });
    if (res.count !== 1) throw conflict();
    return loadListDto(this.prisma, orgId, id);
  }

  /** BR-PL-004: ручна позиція — товар, склад, постачальник організації; список OPEN. */
  async addItem(
    orgId: string,
    listId: string,
    dto: PurchaseListManualItemValues,
  ): Promise<PurchaseListItemResponseDto> {
    await loadList(this.prisma, orgId, listId, { requireOpen: true });
    const [good] = await Promise.all([
      this.prisma.good.findFirst({
        where: { id: dto.goodId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.assertWarehouse(orgId, dto.warehouseId),
      dto.supplierId ? assertSupplier(this.prisma, orgId, dto.supplierId) : Promise.resolve(),
    ]);
    if (!good) throw new NotFoundException(err('err.purchaseList.goodNotFound'));
    const item = await this.prisma.$transaction(
      async tx => {
        // Список міг закритись між перевіркою і записом — перевірка в транзакції.
        await loadList(tx, orgId, listId, { requireOpen: true });
        return tx.purchaseListItem.create({
          data: {
            orgId,
            listId,
            goodId: dto.goodId,
            warehouseId: dto.warehouseId,
            quantity: dto.quantity,
            source: 'MANUAL',
            supplierId: dto.supplierId ?? null,
            expectedPrice: dto.expectedPrice ?? null,
            notes: dto.notes ?? null,
          },
          include: ITEM_INCLUDE,
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return toItemDto(item);
  }

  /**
   * BR-PL-003: товари наряду → у наявний OPEN-список або новий. Кількість за замовчуванням —
   * непокрита потреба рядка (BR-PL-014), у базових одиницях; ≤ 0 → 400 partAlreadyCovered.
   * OPEN-позиція того самого рядка в цільовому списку збільшується. Наряд блокується
   * (`SELECT … FOR UPDATE`) до зміни позицій — непокрита потреба не «з'їдається» двічі.
   */
  async fromWorkOrder(
    orgId: string,
    dto: PurchaseListFromWorkOrderValues,
    role?: string,
  ): Promise<FromWorkOrderResultDto> {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id: dto.workOrderId, orgId, deletedAt: null },
      select: { status: true },
    });
    if (!wo) throw new NotFoundException(err('err.purchaseList.workOrderNotFound'));
    this.assertWorkOrderActive(wo.status);
    if (dto.listId) await loadList(this.prisma, orgId, dto.listId, { requireOpen: true });
    const newNumber = dto.listId ? null : await this.docNumbers.next(orgId, 'PURCHASE_LIST');

    const result = await this.prisma.$transaction(
      async tx => {
        await lockWorkOrdersForUpdate(tx, orgId, [dto.workOrderId]);
        const fresh = await tx.workOrder.findFirst({
          where: { id: dto.workOrderId, orgId, deletedAt: null },
          select: { status: true },
        });
        if (!fresh) throw new NotFoundException(err('err.purchaseList.workOrderNotFound'));
        this.assertWorkOrderActive(fresh.status);

        const partIds = dto.parts.map(p => p.workOrderPartId);
        const parts = await tx.workOrderPart.findMany({
          where: { orgId, workOrderId: dto.workOrderId, id: { in: partIds }, deletedAt: null },
          include: { good: { select: { name: true, preferredSupplierId: true } } },
          take: partIds.length,
        });
        const partById = new Map(parts.map(p => [p.id, p]));
        const missing = partIds.filter(id => !partById.has(id));
        if (missing.length > 0) {
          throw new BadRequestException(
            err('err.purchaseList.partNotFound', { missing: missing.join(', ') }),
          );
        }

        const listId = dto.listId
          ? (await loadList(tx, orgId, dto.listId, { requireOpen: true })).id
          : (
              await tx.purchaseList.create({
                data: {
                  orgId,
                  number: newNumber as string,
                  name: dto.newList?.name ?? null,
                  notes: dto.newList?.notes ?? null,
                },
              })
            ).id;

        const uncovered = await this.shortage.uncoveredByPart(tx, orgId, dto.workOrderId);
        // OPEN-позиції цих рядків у цільовому списку — одним запитом, а не `findFirst` на рядок
        // (sto-optimize, N+1 у транзакції). Щойно створений список позицій не має — не читаємо.
        const openByPart = dto.listId
          ? await this.openItemsByPart(tx, orgId, listId, partIds)
          : new Map<string, OpenItemRef>();
        const itemIds: string[] = [];
        for (const req of dto.parts) {
          const part = partById.get(req.workOrderPartId)!;
          const quantity = req.quantity ?? uncovered.get(part.id) ?? 0;
          if (quantity <= QTY_EPSILON) {
            throw new BadRequestException(
              err('err.purchaseList.partAlreadyCovered', { good: part.good.name }),
            );
          }
          itemIds.push(await this.addOrIncrement(tx, orgId, listId, part, quantity, openByPart));
          // Рядок, повторений у тілі, не бере ту саму непокриту потребу вдруге: позиція вже
          // покриває надіслане, тож повтор без кількості дає partAlreadyCovered.
          uncovered.set(part.id, Math.max(0, (uncovered.get(part.id) ?? 0) - quantity));
        }
        return { listId, itemIds };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    const [list, items] = await Promise.all([
      loadListDto(this.prisma, orgId, result.listId),
      loadItemDtos(this.prisma, orgId, Array.from(new Set(result.itemIds))),
    ]);
    return { list, items: maskItemCost(items, role) };
  }

  /** Найстаріша OPEN-позиція кожного рядка наряду в списку (`workOrderPartId → позиція`). */
  private async openItemsByPart(
    tx: Tx,
    orgId: string,
    listId: string,
    partIds: string[],
  ): Promise<Map<string, OpenItemRef>> {
    const rows = await tx.purchaseListItem.findMany({
      where: {
        orgId,
        listId,
        workOrderPartId: { in: partIds },
        status: 'OPEN',
        deletedAt: null,
      },
      select: { id: true, quantity: true, workOrderPartId: true, offerMultiplicity: true },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
    const result = new Map<string, OpenItemRef>();
    for (const r of rows) {
      if (r.workOrderPartId && !result.has(r.workOrderPartId)) {
        result.set(r.workOrderPartId, {
          id: r.id,
          quantity: r.quantity,
          offerMultiplicity: r.offerMultiplicity,
        });
      }
    }
    return result;
  }

  /**
   * OPEN-позиція рядка в списку збільшується, інакше створюється нова. `openByPart` — позиції,
   * прочитані до циклу; оновлюється тут, тож рядок, повторений у тілі, бачить уже записане.
   */
  private async addOrIncrement(
    tx: Tx,
    orgId: string,
    listId: string,
    part: {
      id: string;
      workOrderId: string;
      goodId: string;
      warehouseId: string;
      good: { preferredSupplierId: string | null };
    },
    quantity: number,
    openByPart: Map<string, OpenItemRef>,
  ): Promise<string> {
    const existing = openByPart.get(part.id);
    if (existing) {
      // BR-SOFR-006: обрана пропозиція лишається — сума до її кратності вгору.
      const next = { ...existing, ...setItemQuantity(existing, existing.quantity + quantity) };
      const res = await tx.purchaseListItem.updateMany({
        where: { id: existing.id, orgId, ...OPEN_ITEM_WHERE, quantity: existing.quantity },
        data: { quantity: next.quantity },
      });
      if (res.count !== 1) throw conflict();
      openByPart.set(part.id, next);
      return existing.id;
    }
    const created = await tx.purchaseListItem.create({
      data: {
        orgId,
        listId,
        goodId: part.goodId,
        warehouseId: part.warehouseId,
        quantity,
        source: 'WORK_ORDER',
        workOrderId: part.workOrderId,
        workOrderPartId: part.id,
        supplierId: part.good.preferredSupplierId ?? null,
      },
      select: { id: true },
    });
    openByPart.set(part.id, { id: created.id, quantity, offerMultiplicity: null });
    return created.id;
  }

  /**
   * BR-PL-006: ціль і джерела — OPEN; усі невидалені позиції джерел переходять у ціль; джерела →
   * CLOSED з mergedIntoId і closedAt. Склади позицій не обмежуються.
   */
  async merge(
    orgId: string,
    dto: PurchaseListMergeValues,
    role?: string,
  ): Promise<PurchaseListDetailDto> {
    const sources = Array.from(new Set(dto.sourceListIds));
    if (sources.includes(dto.targetListId)) {
      throw new BadRequestException(err('err.purchaseList.mergeIntoItself'));
    }
    await this.prisma.$transaction(
      async tx => {
        await loadList(tx, orgId, dto.targetListId, { requireOpen: true });
        const found = await tx.purchaseList.findMany({
          where: { orgId, id: { in: sources }, deletedAt: null },
          select: { id: true, status: true },
        });
        if (found.length !== sources.length) {
          throw new NotFoundException(err('err.purchaseList.notFound'));
        }
        if (found.some(l => l.status !== 'OPEN')) {
          throw new BadRequestException(err('err.purchaseList.listNotOpen'));
        }
        const closed = await tx.purchaseList.updateMany({
          where: { orgId, id: { in: sources }, status: 'OPEN', deletedAt: null },
          data: { status: 'CLOSED', mergedIntoId: dto.targetListId, closedAt: new Date() },
        });
        if (closed.count !== sources.length) throw conflict();
        // Ціль лишається OPEN до коміту: зміна статусу з іншого запиту чекає на цей рядок.
        const target = await tx.purchaseList.updateMany({
          where: { orgId, id: dto.targetListId, status: 'OPEN', deletedAt: null },
          data: { closedAt: null },
        });
        if (target.count !== 1) throw conflict();
        await tx.purchaseListItem.updateMany({
          where: { orgId, listId: { in: sources }, deletedAt: null },
          data: { listId: dto.targetListId },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return this.findOne(orgId, dto.targetListId, role);
  }

  /** Закрити список вручну (OPEN → CLOSED); позиції лишаються як є. */
  async close(orgId: string, id: string): Promise<PurchaseListResponseDto> {
    await loadList(this.prisma, orgId, id, { requireOpen: true });
    const res = await this.prisma.purchaseList.updateMany({
      where: { id, orgId, status: 'OPEN', deletedAt: null },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    if (res.count !== 1) throw conflict();
    return loadListDto(this.prisma, orgId, id);
  }

  /** Скасувати список — лише без ORDERED/RECEIVED позицій; OPEN-позиції → CANCELLED. */
  async cancel(orgId: string, id: string): Promise<PurchaseListResponseDto> {
    await loadList(this.prisma, orgId, id, { requireOpen: true });
    await this.prisma.$transaction(
      async tx => {
        await this.assertNothingOrdered(tx, orgId, id);
        const res = await tx.purchaseList.updateMany({
          where: { id, orgId, status: 'OPEN', deletedAt: null },
          data: { status: 'CANCELLED', closedAt: new Date() },
        });
        if (res.count !== 1) throw conflict();
        await tx.purchaseListItem.updateMany({
          where: { orgId, listId: id, status: 'OPEN', deletedAt: null },
          data: { status: 'CANCELLED' },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return loadListDto(this.prisma, orgId, id);
  }

  /** Видалити (soft) — лише без ORDERED/RECEIVED позицій; позиції видаляються разом зі списком. */
  async remove(orgId: string, id: string): Promise<void> {
    const list = await loadList(this.prisma, orgId, id);
    await this.prisma.$transaction(
      async tx => {
        await this.assertNothingOrdered(tx, orgId, id);
        const deletedAt = new Date();
        const res = await tx.purchaseList.updateMany({
          where: { id, orgId, status: list.status, deletedAt: null },
          data: { deletedAt },
        });
        if (res.count !== 1) throw conflict();
        await tx.purchaseListItem.updateMany({
          where: { orgId, listId: id, deletedAt: null },
          data: { status: 'CANCELLED', deletedAt },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  // ─── Зв'язки ──────────────────────────────────────────────

  /**
   * Наряди й замовлення постачальникам позицій списку, списки, злиті в нього (BR-PL-020).
   * §2.1: сума замовлення — закупівельна, її бачать лише PURCHASE_PRICE_VISIBLE_ROLES (приймальні
   * відкрито перегляд списків, BR-PL-015, — вона отримує `null`, як і очікувану ціну позиції).
   */
  async getLinkedDocuments(
    orgId: string,
    id: string,
    role?: string,
  ): Promise<PurchaseListLinkedDocumentsDto> {
    // BR-WO-012: джерело шукаємо й серед видалених (orgId лишається). Позиції видаляються разом
    // зі списком тією ж міткою `deletedAt` (`remove`) — у видаленого списку беремо саме їх.
    const list = await this.prisma.purchaseList.findFirst({
      where: { id, orgId },
      select: { id: true, deletedAt: true },
    });
    if (!list) return { workOrders: [], purchaseOrders: [], purchaseLists: [] };
    const TAKE = 500;
    const [items, merged] = await Promise.all([
      this.prisma.purchaseListItem.findMany({
        where: { orgId, listId: id, deletedAt: list.deletedAt },
        select: {
          workOrder: { select: { id: true, number: true, status: true, deletedAt: true } },
          purchaseOrder: {
            select: {
              id: true,
              number: true,
              status: true,
              deletedAt: true,
              totalAmount: true,
              currency: { select: { symbol: true, code: true } },
            },
          },
        },
        take: TAKE * 4,
      }),
      this.prisma.purchaseList.findMany({
        where: { orgId, mergedIntoId: id, deletedAt: null },
        select: { id: true, number: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
    ]);
    const showCost = canSeeItemCost(role);
    const unique = <T extends { id: string; deletedAt: Date | null }>(rows: (T | null)[]) =>
      Array.from(
        new Map(
          rows
            .filter((r): r is T => r !== null && r.deletedAt === null)
            .map(({ deletedAt: _d, ...rest }) => [rest.id, rest]),
        ).values(),
      ).slice(0, TAKE);
    return {
      workOrders: unique(items.map(i => i.workOrder)),
      purchaseOrders: unique(items.map(i => i.purchaseOrder)).map(
        ({ totalAmount, currency, ...po }) => ({
          ...po,
          totalAmount: showCost ? Number(totalAmount) : null,
          currencySymbol: currency?.symbol || currency?.code || null,
        }),
      ),
      purchaseLists: merged.map(l => ({ ...l, createdAt: l.createdAt.toISOString() })),
    };
  }

  async getLinkedCounts(orgId: string, ids: string[]) {
    if (!ids.length) return {};
    // Пари (список, наряд) і (список, замовлення) — `groupBy` у БД, а не всі позиції списків.
    const itemsWhere = { orgId, listId: { in: ids }, deletedAt: null };
    const [woPairs, poPairs, merged] = await Promise.all([
      this.prisma.purchaseListItem.groupBy({
        by: ['listId', 'workOrderId'],
        where: { ...itemsWhere, workOrder: { deletedAt: null } },
      }),
      this.prisma.purchaseListItem.groupBy({
        by: ['listId', 'purchaseOrderId'],
        where: { ...itemsWhere, purchaseOrder: { deletedAt: null } },
      }),
      this.prisma.purchaseList.groupBy({
        by: ['mergedIntoId'],
        where: { orgId, mergedIntoId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
    ]);
    const result = initCountsMap(ids, ['workOrders', 'purchaseOrders', 'purchaseLists'] as const);
    for (const g of woPairs) if (g.workOrderId && result[g.listId]) result[g.listId].workOrders++;
    for (const g of poPairs) {
      if (g.purchaseOrderId && result[g.listId]) result[g.listId].purchaseOrders++;
    }
    for (const g of merged) {
      if (g.mergedIntoId && result[g.mergedIntoId]) {
        result[g.mergedIntoId].purchaseLists = g._count._all;
      }
    }
    return result;
  }

  // ─── Допоміжне ────────────────────────────────────────────

  private assertWorkOrderActive(status: string): void {
    if (!(PROCUREMENT_ACTIVE_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(err('err.purchaseList.workOrderNotActive'));
    }
  }

  private async assertWarehouse(orgId: string, warehouseId: string): Promise<void> {
    const wh = await this.prisma.warehouse.findFirst({
      where: { id: warehouseId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!wh) throw new NotFoundException(err('err.purchaseList.warehouseNotFound'));
  }

  private async assertNothingOrdered(tx: Tx, orgId: string, listId: string): Promise<void> {
    const ordered = await tx.purchaseListItem.count({
      where: { orgId, listId, deletedAt: null, status: { in: ['ORDERED', 'RECEIVED'] } },
    });
    if (ordered > 0) throw new BadRequestException(err('err.purchaseList.cancelHasOrdered'));
  }
}
