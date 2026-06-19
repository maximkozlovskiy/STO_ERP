import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma, PurchaseOrderStatus } from '@prisma/client';

import { kyivToday } from '../../common/utils/kyiv-date';
import { assertFsmTransition } from '../../common/utils/fsm';
import { safeCoeff } from '../../common/utils/math';
import { calculatePagination } from '../../common/utils/pagination';
import { deduplicateBy } from '../../common/utils/array';
import { PrismaService } from '../../prisma/prisma.service';
import { formatPersonName, TRANSACTION_TIMEOUT_MS, MAX_QUERY_LIMIT } from '@sto/shared';
import { DocumentNumberService } from '../document-number/document-number.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { PricingService } from '../inventory/pricing.service';
import { SettingsService } from '../settings/settings.service';
import { calcLineVat } from '../../common/utils/vat';
import {
  CreatePurchaseOrderDto,
  UpdatePurchaseOrderDto,
  ReceivePurchaseOrderDto,
  PurchaseOrderResponseDto,
  PaginatedPurchaseOrdersDto,
} from './purchase-orders.dto';

type POStatus = PurchaseOrderStatus;

const PO_TRANSITIONS: Record<POStatus, POStatus[]> = {
  DRAFT: [PurchaseOrderStatus.ORDERED, PurchaseOrderStatus.CANCELLED],
  ORDERED: [
    PurchaseOrderStatus.PARTIAL,
    PurchaseOrderStatus.RECEIVED,
    PurchaseOrderStatus.CANCELLED,
  ],
  PARTIAL: [PurchaseOrderStatus.RECEIVED, PurchaseOrderStatus.CANCELLED],
  RECEIVED: [],
  CANCELLED: [],
};

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly settlements: SettlementsService,
    private readonly docNumbers: DocumentNumberService,
    private readonly pricingService: PricingService,
    private readonly settingsService: SettingsService,
  ) {}

  async findAll(
    orgId: string,
    page = 1,
    limit = 20,
    status?: string,
    q?: string,
    showDeleted = false,
    dateFrom?: string,
    dateTo?: string,
    sortBy?: string,
    sortDir?: 'asc' | 'desc',
  ): Promise<PaginatedPurchaseOrdersDto> {
    const where: Prisma.PurchaseOrderWhereInput = {
      orgId,
      ...(showDeleted ? {} : { deletedAt: null }),
    };
    if (status) where.status = status as POStatus;
    if (q) {
      const like = q.trim();
      if (like.length > 0) {
        where.OR = [
          { number: { contains: like, mode: 'insensitive' } },
          {
            supplier: {
              OR: [
                { companyName: { contains: like, mode: 'insensitive' } },
                { lastName: { contains: like, mode: 'insensitive' } },
                { firstName: { contains: like, mode: 'insensitive' } },
              ],
            },
          },
        ];
      }
    }
    if (dateFrom || dateTo) {
      where.documentDate = {
        ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo ? { lte: new Date(dateTo + 'T23:59:59.999Z') } : {}),
      };
    }

    const { skip, take } = calculatePagination({ page, limit });
    const PO_SORT: Record<string, string> = {
      documentDate: 'documentDate',
      createdAt: 'createdAt',
      totalAmount: 'totalAmount',
    };
    const sortField = PO_SORT[sortBy ?? ''] ?? 'createdAt';
    const sortOrder = sortDir === 'asc' ? 'asc' : 'desc';
    const [items, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where,
        skip,
        take,
        orderBy: { [sortField]: sortOrder },
        // Lines omitted from list — loaded on demand via findOne when detail opens.
        // Avoids fetching up to 1000 line rows × 20 POs per list request.
        // Bug #349: include contract so list shows contractNumber (toDto maps it).
        include: {
          supplier: { select: { firstName: true, lastName: true, companyName: true } },
          warehouse: { select: { name: true } },
          contract: { select: { id: true, number: true } },
          _count: { select: { lines: { where: { deletedAt: null } } } },
        },
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);

    return {
      items: items.map(item => this.toDto(item as Parameters<typeof this.toDto>[0])),
      total,
      page,
      limit: take,
    };
  }

  async findOne(orgId: string, id: string): Promise<PurchaseOrderResponseDto> {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      // Bug #349: include contract so detail shows contractNumber (toDto maps it).
      include: {
        supplier: { select: { firstName: true, lastName: true, companyName: true } },
        warehouse: { select: { name: true } },
        contract: { select: { id: true, number: true } },
        lines: {
          where: { deletedAt: null },
          include: {
            good: {
              select: {
                name: true,
                internalCode: true,
                sku: true,
                unit: true,
                unitOfMeasure: { select: { shortName: true, coefficient: true } },
                brand: { select: { name: true } },
              },
            },
          },
          take: 1000,
        },
      },
    });
    if (!po) throw new NotFoundException('Замовлення не знайдено');
    return this.toDto(po);
  }

  async create(orgId: string, dto: CreatePurchaseOrderDto): Promise<PurchaseOrderResponseDto> {
    // sto-optimize: tier-merger Promise.all — supplier+warehouse guards паралельні з
    // contract resolution. Раніше contract auto-pick/validate йшов sequential ПІСЛЯ Promise.all,
    // додаючи 1 RTT навіть коли FK guards проходили миттєво. Auto-pick предикат
    // (counterpartyId=dto.supplierId) відомий синхронно з DTO, не потребує результату
    // supplier guard. NotFound/order повідомлень не страждає — всі awaits завершуються
    // ДО throw-блоків, помилки кидаються у тому самому порядку.
    const hasContractId = !!dto.contractId;
    const [supplier, warehouse, contract] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: dto.supplierId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.warehouse.findFirst({
        where: { id: dto.warehouseId, orgId, deletedAt: null },
        select: { id: true },
      }),
      hasContractId
        ? this.prisma.counterpartyContract.findFirst({
            where: {
              id: dto.contractId as string,
              orgId,
              counterpartyId: dto.supplierId,
              contractType: 'PURCHASE',
              deletedAt: null,
            },
            select: { id: true },
          })
        : this.prisma.counterpartyContract.findFirst({
            where: {
              counterpartyId: dto.supplierId,
              orgId,
              contractType: 'PURCHASE',
              deletedAt: null,
            },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            select: { id: true },
          }),
    ]);
    if (!supplier) throw new NotFoundException('Постачальника не знайдено');
    if (!warehouse) throw new NotFoundException('Склад не знайдено');
    if (hasContractId && !contract) throw new NotFoundException('Договір не знайдено');
    const contractId: string | null = hasContractId
      ? (contract as { id: string }).id
      : (contract?.id ?? null);

    const number = await this.docNumbers.next(orgId, 'PURCHASE_ORDER');

    const lines = dto.lines ?? [];
    const { vatMode, vatRate } = await this.settingsService.getDefaultVatRate(orgId);
    const computedLines = lines.map(l => {
      const { vatAmount } = calcLineVat(l.price, l.quantity, vatRate, vatMode);
      return { ...l, vatRate, vatAmount };
    });
    const totalAmount = computedLines.reduce((s, l) => s + l.quantity * l.price, 0);
    const totalVat = computedLines.reduce((s, l) => s + l.vatAmount, 0);

    const po = await this.prisma.$transaction(
      async tx => {
        const created = await tx.purchaseOrder.create({
          data: {
            orgId,
            supplierId: dto.supplierId,
            warehouseId: dto.warehouseId,
            contractId,
            number,
            notes: dto.notes,
            totalAmount,
            totalVat,
            documentDate: dto.documentDate ? new Date(dto.documentDate) : kyivToday(),
          },
        });
        if (computedLines.length) {
          await tx.purchaseOrderLine.createMany({
            data: computedLines.map(l => ({
              orgId,
              purchaseOrderId: created.id,
              goodId: l.goodId,
              quantity: l.quantity,
              price: l.price,
              vatRate: l.vatRate,
              vatAmount: l.vatAmount,
            })),
          });
        }
        return tx.purchaseOrder.findFirstOrThrow({
          where: { id: created.id, orgId, deletedAt: null },
          include: {
            supplier: { select: { firstName: true, lastName: true, companyName: true } },
            warehouse: { select: { name: true } },
            contract: { select: { id: true, number: true } },
            lines: {
              where: { deletedAt: null },
              take: 1000,
              include: {
                good: {
                  select: {
                    name: true,
                    internalCode: true,
                    sku: true,
                    unit: true,
                    unitOfMeasure: { select: { shortName: true, coefficient: true } },
                    brand: { select: { name: true } },
                  },
                },
              },
            },
          },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // Bug #132: explicit timeout

    return this.toDto(po);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdatePurchaseOrderDto,
  ): Promise<PurchaseOrderResponseDto> {
    // sto-optimize: narrow projection — потрібен лише status (guard) + totalAmount (fallback
    // коли dto.lines не передано) + supplierId (щоб обчислити effectiveSupplierId для
    // contractId-валідації і виявити зміну постачальника, що потребує очищення стейл-контракту).
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true, totalAmount: true, supplierId: true, contractId: true },
    });
    if (!po) throw new NotFoundException('Замовлення не знайдено');
    if (po.status !== PurchaseOrderStatus.DRAFT)
      throw new BadRequestException('Редагувати можна лише чернетку');

    // sto-optimize: всі 3 FK guards незалежні (supplier, warehouse, contract) — кожна
    // лише для NotFoundException-перевірки. Раніше sequential — кожен await блокував
    // наступний. Тепер Promise.all з тернарками — економить до 2 RTT при повному
    // оновленні форми (supplier+warehouse+contract разом). Bug review §1.2.
    //
    // Contract resolution:
    //   1. Client explicit contractId (string)  → validate against effective supplier
    //   2. Client explicit null/empty           → clear contractId
    //   3. Supplier changed and client silent   → auto-clear stale contract (would point
    //      to old supplier, creating cross-supplier orphan reference)
    //   4. Otherwise                            → keep existing (Prisma `undefined`)
    const supplierChanged = dto.supplierId !== undefined && dto.supplierId !== po.supplierId;
    const effectiveSupplierId = dto.supplierId ?? po.supplierId;
    const shouldValidateContract = !!dto.contractId;

    const [supplier, warehouse, contract] = await Promise.all([
      dto.supplierId
        ? this.prisma.counterparty.findFirst({
            where: { id: dto.supplierId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.warehouseId
        ? this.prisma.warehouse.findFirst({
            where: { id: dto.warehouseId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      shouldValidateContract
        ? this.prisma.counterpartyContract.findFirst({
            where: {
              id: dto.contractId as string,
              orgId,
              counterpartyId: effectiveSupplierId,
              contractType: 'PURCHASE',
              deletedAt: null,
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    if (dto.supplierId && !supplier) throw new NotFoundException('Постачальника не знайдено');
    if (dto.warehouseId && !warehouse) throw new NotFoundException('Склад не знайдено');
    if (shouldValidateContract && !contract) throw new NotFoundException('Договір не знайдено');

    const newContractId: string | null | undefined =
      shouldValidateContract && contract
        ? contract.id
        : dto.contractId === null || (supplierChanged && po.contractId)
          ? null
          : undefined;

    const lines = dto.lines;
    const { vatMode, vatRate } = await this.settingsService.getDefaultVatRate(orgId);
    const computedLines = lines?.map(l => {
      const { vatAmount } = calcLineVat(l.price, l.quantity, vatRate, vatMode);
      return { ...l, vatRate, vatAmount };
    });
    const totalAmount = computedLines
      ? computedLines.reduce((s, l) => s + l.quantity * l.price, 0)
      : Number(po.totalAmount);
    const totalVat = computedLines ? computedLines.reduce((s, l) => s + l.vatAmount, 0) : undefined;

    const updated = await this.prisma.$transaction(
      async tx => {
        if (computedLines !== undefined) {
          await tx.purchaseOrderLine.updateMany({
            where: { purchaseOrderId: id, orgId },
            data: { deletedAt: new Date() },
          });
          if (computedLines.length) {
            await tx.purchaseOrderLine.createMany({
              data: computedLines.map(l => ({
                orgId,
                purchaseOrderId: id,
                goodId: l.goodId,
                quantity: l.quantity,
                price: l.price,
                vatRate: l.vatRate,
                vatAmount: l.vatAmount,
                ...(l.pricedSalePrice != null ? { pricedSalePrice: l.pricedSalePrice } : {}),
              })),
            });
          }
        }
        return tx.purchaseOrder.update({
          where: { id, orgId },
          data: {
            supplierId: dto.supplierId ?? undefined,
            warehouseId: dto.warehouseId ?? undefined,
            contractId: newContractId,
            notes: dto.notes,
            totalAmount,
            ...(totalVat !== undefined ? { totalVat } : {}),
            documentDate: dto.documentDate ? new Date(dto.documentDate) : undefined,
          },
          include: {
            supplier: { select: { firstName: true, lastName: true, companyName: true } },
            warehouse: { select: { name: true } },
            contract: { select: { id: true, number: true } },
            lines: {
              where: { deletedAt: null },
              take: 1000,
              include: {
                good: {
                  select: {
                    name: true,
                    internalCode: true,
                    sku: true,
                    unit: true,
                    unitOfMeasure: { select: { shortName: true, coefficient: true } },
                    brand: { select: { name: true } },
                  },
                },
              },
            },
          },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // Bug #132: explicit timeout

    return this.toDto(updated);
  }

  async transition(
    orgId: string,
    id: string,
    newStatus: POStatus,
  ): Promise<PurchaseOrderResponseDto> {
    await this.prisma.$transaction(
      async tx => {
        // sto-optimize: status-only projection — assertFsmTransition потребує лише поточний статус.
        const po = await tx.purchaseOrder.findFirst({
          where: { id, orgId, deletedAt: null },
          select: { status: true },
        });
        if (!po) throw new NotFoundException('Замовлення не знайдено');

        assertFsmTransition(PO_TRANSITIONS, po.status as POStatus, newStatus);

        await tx.purchaseOrder.update({ where: { id, orgId }, data: { status: newStatus } });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // Bug #132: explicit timeout
    return this.findOne(orgId, id);
  }

  async receive(
    orgId: string,
    id: string,
    dto: ReceivePurchaseOrderDto,
    userId?: string,
  ): Promise<PurchaseOrderResponseDto> {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        lines: {
          where: { deletedAt: null },
          take: 1000,
          include: { good: { select: { unitId: true } } },
        },
      },
    });
    if (!po) throw new NotFoundException('Замовлення не знайдено');
    if (po.status !== PurchaseOrderStatus.ORDERED && po.status !== PurchaseOrderStatus.PARTIAL) {
      throw new BadRequestException(
        'Прийом можливий лише для замовлень зі статусом ORDERED або PARTIAL',
      );
    }

    // §2.2 Tenant isolation: validate that any unitOfMeasureId override the caller passed
    // belongs to the same orgId (FK alone does not enforce tenant boundaries because UoM
    // model has its own orgId and Prisma FK has no composite (orgId, id) constraint).
    const overrideUomIds = Array.from(
      new Set(
        dto.lines
          .map(l => l.unitOfMeasureId)
          .filter((v): v is string => typeof v === 'string' && v.length > 0),
      ),
    );
    let allowedUomIds: Set<string> = new Set();
    if (overrideUomIds.length) {
      const allowed = await this.prisma.unitOfMeasure.findMany({
        where: { orgId, id: { in: overrideUomIds }, deletedAt: null },
        select: { id: true },
        // Safety cap — bounded by overrideUomIds (PO lines) but cap protects
        // against OOM if a PO ever has >1000 lines with override UoMs.
        take: MAX_QUERY_LIMIT,
      });
      allowedUomIds = new Set(allowed.map(u => u.id));
      const missing = overrideUomIds.filter(id => !allowedUomIds.has(id));
      if (missing.length) {
        throw new BadRequestException('Одиницю виміру не знайдено в межах організації');
      }
    }

    // Bug review: dedupe protection on lineId — без цього клієнт міг би відправити дві
    // recv-записи з тим самим lineId і отримати подвійний `increment` (Promise.all виконує
    // обидва update — навіть якщо у одній tx, обидва зростають).
    const seen = new Set<string>();
    for (const recv of dto.lines) {
      if (seen.has(recv.lineId)) {
        throw new BadRequestException('Кожен рядок прийому має бути унікальним');
      }
      seen.add(recv.lineId);
    }

    // sto-optimize: всі лінії незалежні (різні lineId/goodId rows) — паралелимо.
    // Всередині лінії: createMovement і lineUpdate пишуть у різні таблиці → теж паралельно.
    // NB: Prisma всередині $transaction виконує DB-операції послідовно (один pinned connection),
    // тож Promise.all дає лише JS-overhead-economy. receivedAmount акумулюємо через map → reduce
    // (уникаємо shared mutable у async callbacks).
    const activeLines = dto.lines
      .map(recv => ({ recv, line: po.lines.find(l => l.id === recv.lineId) }))
      .filter(
        (x): x is { recv: (typeof dto.lines)[0]; line: NonNullable<typeof x.line> } =>
          !!x.line && x.recv.receivedQty > 0,
      );

    const receivedAmount = activeLines.reduce(
      (sum, { recv, line }) => sum + recv.receivedQty * Number(line.price),
      0,
    );

    await this.prisma.$transaction(
      async tx => {
        await Promise.all(
          activeLines.map(({ recv, line }) => {
            // Prefer caller-provided UoM override (already validated against orgId above);
            // fall back to Good.unitId, then null (backward compat with nullable column).
            const resolvedUomId =
              (recv.unitOfMeasureId && allowedUomIds.has(recv.unitOfMeasureId)
                ? recv.unitOfMeasureId
                : null) ??
              line.good?.unitId ??
              null;
            // Bug #237: avoid overwriting an existing PO line UoM on subsequent partial
            // receives. Only persist UoM when (a) this is the first receive (no prior qty),
            // or (b) the caller passed an explicit override — otherwise keep the original.
            const shouldUpdateLineUom = line.receivedQty === 0 || !!recv.unitOfMeasureId;
            return Promise.all([
              this.inventory.createMovement(
                orgId,
                {
                  goodId: line.goodId,
                  warehouseId: po.warehouseId,
                  type: 'RECEIPT',
                  quantity: recv.receivedQty,
                  price: Number(line.price),
                  documentType: 'PurchaseOrder',
                  documentId: id,
                  createdBy: userId,
                  unitOfMeasureId: resolvedUomId,
                },
                tx,
              ),
              tx.purchaseOrderLine.update({
                where: { id: recv.lineId, orgId },
                data: {
                  receivedQty: { increment: recv.receivedQty },
                  ...(shouldUpdateLineUom ? { unitOfMeasureId: resolvedUomId } : {}),
                },
              }),
            ]);
          }),
        );

        // Record payable to supplier for goods received in this batch
        if (receivedAmount > 0) {
          await this.settlements.createTransaction(
            orgId,
            {
              counterpartyId: po.supplierId,
              type: 'CHARGE',
              amount: receivedAmount,
              documentType: 'PurchaseOrder',
              documentId: id,
              createdBy: userId,
            },
            tx,
          );
        }

        // Determine and apply new status inside the same transaction
        const updatedLines = await tx.purchaseOrderLine.findMany({
          where: { purchaseOrderId: id, orgId, deletedAt: null },
          take: 1000,
        });
        const allReceived = updatedLines.every(l => l.receivedQty >= l.quantity);
        const anyReceived = updatedLines.some(l => l.receivedQty > 0);
        const newStatus = allReceived
          ? PurchaseOrderStatus.RECEIVED
          : anyReceived
            ? PurchaseOrderStatus.PARTIAL
            : po.status;
        await tx.purchaseOrder.update({ where: { id, orgId }, data: { status: newStatus } });
      },
      { timeout: 30_000 },
    ); // Bug #132: explicit timeout — велике PO (сотні рядків) × createMovement з batch-tracking
    return this.findOne(orgId, id);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Narrow tenant guard — потрібен лише `status` для DRAFT check.
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true },
    });
    if (!po) throw new NotFoundException('Замовлення не знайдено');
    if (po.status !== PurchaseOrderStatus.DRAFT)
      throw new BadRequestException('Видалити можна лише чернетку');
    // Race-safe updateMany з повним compound where (id+orgId+deletedAt:null).
    await this.prisma.purchaseOrder.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  async applyPricing(
    orgId: string,
    poId: string,
  ): Promise<{
    updated: number;
    details: {
      goodId: string;
      goodName: string;
      costPrice: number;
      oldSalePrice: number;
      newSalePrice: number;
    }[];
  }> {
    // Perf: select narrow projection for pricing — Brand record entirely unused (only brandId
    // scalar read), Good's heavy columns (description, barcodes, customFields) likewise unused.
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: poId, orgId, deletedAt: null },
      select: {
        id: true,
        number: true,
        status: true,
        supplierId: true,
        lines: {
          where: { deletedAt: null },
          select: {
            id: true,
            goodId: true,
            price: true,
            good: {
              select: {
                id: true,
                name: true,
                salePrice: true,
                category: true,
                goodType: true,
                brandId: true,
              },
            },
          },
        },
      },
    });
    if (!po) throw new NotFoundException('Замовлення не знайдено');
    // Defense-in-depth: розцінювати можна лише отримані товари (UI рендерить кнопку
    // тільки для RECEIVED/PARTIAL, але клієнт міг бути обійдений)
    if (po.status !== PurchaseOrderStatus.RECEIVED && po.status !== PurchaseOrderStatus.PARTIAL) {
      throw new BadRequestException(
        'Розцінити можна лише отримані товари (статус RECEIVED або PARTIAL)',
      );
    }

    // Bug #194: prefetch active rules once — раніше calculateSalePrice fetch-ив правила
    // у циклі (N+1), та кожна лінія викликала окремий $transaction без timeout.
    // Тепер: 1 query на правила + 1 транзакція з chunked updates + explicit timeout.
    const rules = await this.pricingService.getActiveRulesForOrg(orgId);

    type Plan = {
      lineId: string;
      goodId: string;
      goodName: string;
      costPrice: number;
      oldSalePrice: number;
      newSalePrice: number;
      ruleName: string | null;
    };
    const plan: Plan[] = [];

    for (const line of po.lines) {
      if (!line.good) continue;
      const costPrice = Number(line.price);
      const oldSalePrice = Number(line.good.salePrice);
      const { price: newSalePrice, ruleName } = this.pricingService.resolveRule(
        rules,
        line.goodId,
        line.good.category ?? undefined,
        line.good.goodType ?? undefined,
        line.good.brandId ?? undefined,
        costPrice,
        po.supplierId ?? undefined,
      );
      plan.push({
        lineId: line.id,
        goodId: line.goodId,
        goodName: line.good.name,
        costPrice,
        oldSalePrice,
        newSalePrice,
        ruleName,
      });
    }

    if (plan.length === 0) return { updated: 0, details: [] };

    // Дедуп по goodId для Good.salePrice update (last-write-wins для однакових goodId).
    const dedupedPlan = deduplicateBy(
      plan.filter(u => Math.abs(u.newSalePrice - u.oldSalePrice) >= 0.001),
      u => u.goodId,
    );

    const CHUNK = 100;

    // 1. Оновити Good.salePrice + PriceHistory лише для змінених цін
    if (dedupedPlan.length > 0) {
      for (let i = 0; i < dedupedPlan.length; i += CHUNK) {
        const chunk = dedupedPlan.slice(i, i + CHUNK);
        await this.prisma.$transaction(
          async tx => {
            await Promise.all(
              chunk.map(u =>
                tx.good.updateMany({
                  where: { id: u.goodId, orgId, deletedAt: null },
                  data: { salePrice: u.newSalePrice },
                }),
              ),
            );
            await tx.priceHistory.createMany({
              data: chunk.map(u => ({
                orgId,
                goodId: u.goodId,
                oldPrice: u.oldSalePrice,
                newPrice: u.newSalePrice,
                costPrice: u.costPrice,
                reason: `PO pricing: ${po.number}`,
              })),
            });
          },
          { timeout: 10_000 },
        );
      }
    }

    // 2. Оновити pricedSalePrice + pricingRuleName на кожній лінії (для всіх ліній)
    for (let i = 0; i < plan.length; i += CHUNK) {
      const chunk = plan.slice(i, i + CHUNK);
      await this.prisma.$transaction(
        async tx => {
          await Promise.all(
            chunk.map(u =>
              tx.purchaseOrderLine.update({
                where: { id: u.lineId },
                data: { pricedSalePrice: u.newSalePrice, pricingRuleName: u.ruleName },
              }),
            ),
          );
        },
        { timeout: 10_000 },
      );
    }

    await this.prisma.purchaseOrder.updateMany({
      where: { id: poId, orgId },
      data: { pricedAt: new Date() },
    });

    // updated = кількість ліній для яких знайдено правило (незалежно від зміни ціни)
    return { updated: plan.filter(u => u.ruleName !== null).length, details: plan };
  }

  private toDto(po: {
    id: string;
    orgId: string;
    number: string;
    status: PurchaseOrderStatus;
    supplierId: string;
    warehouseId: string;
    contractId?: string | null;
    totalAmount: import('@prisma/client').Prisma.Decimal;
    totalVat?: import('@prisma/client').Prisma.Decimal | null;
    notes: string | null;
    documentDate?: Date | null;
    pricedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt?: Date | null;
    supplier: {
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
    } | null;
    warehouse: { name: string } | null;
    contract?: { id: string; number: string } | null;
    lines?: Array<{
      id: string;
      goodId: string;
      quantity: number;
      price: import('@prisma/client').Prisma.Decimal;
      vatRate?: import('@prisma/client').Prisma.Decimal | null;
      vatAmount?: import('@prisma/client').Prisma.Decimal | null;
      receivedQty: number;
      pricedSalePrice?: import('@prisma/client').Prisma.Decimal | null;
      pricingRuleName?: string | null;
      unitOfMeasureId?: string | null;
      good: {
        name: string;
        internalCode?: string | null;
        sku: string | null;
        unit: string;
        unitOfMeasure: { shortName: string; coefficient: number } | null;
        brand?: { name: string } | null;
      } | null;
    }>;
    _count?: { lines: number };
  }): PurchaseOrderResponseDto {
    const sup = po.supplier;
    const supplierName =
      formatPersonName(sup?.lastName, sup?.firstName, sup?.companyName) || undefined;
    return {
      id: po.id,
      orgId: po.orgId,
      number: po.number,
      status: po.status,
      supplierId: po.supplierId,
      supplierName,
      warehouseId: po.warehouseId,
      warehouseName: po.warehouse?.name,
      contractId: po.contractId ?? null,
      contractNumber: po.contract?.number ?? null,
      totalAmount: Number(po.totalAmount),
      totalVat: Number(po.totalVat ?? 0),
      notes: po.notes ?? null,
      documentDate: po.documentDate ? po.documentDate.toISOString().slice(0, 10) : null,
      pricedAt: po.pricedAt ?? null,
      linesCount: po._count?.lines ?? po.lines?.length ?? 0,
      deletedAt: po.deletedAt ?? null,
      lines: (po.lines ?? []).map(l => ({
        id: l.id,
        goodId: l.goodId,
        goodName: l.good?.name,
        goodSku: l.good?.sku ?? null,
        goodInternalCode: l.good?.internalCode ?? null,
        goodBrandName: l.good?.brand?.name ?? null,
        unit: l.good?.unit,
        unitShortName: l.good?.unitOfMeasure?.shortName ?? l.good?.unit,
        // Bug #316: safeCoeff() ловить legacy/seed coefficient=0/NaN/негативні —
        // фронт використовує coefficient як дільник для display↔base conversion.
        coefficient: safeCoeff(l.good?.unitOfMeasure?.coefficient),
        quantity: l.quantity,
        price: Number(l.price),
        amount: l.quantity * Number(l.price),
        vatRate: Number(l.vatRate ?? 0),
        vatAmount: Number(l.vatAmount ?? 0),
        receivedQty: l.receivedQty,
        pricedSalePrice: l.pricedSalePrice != null ? Number(l.pricedSalePrice) : null,
        pricingRuleName: l.pricingRuleName ?? null,
        unitOfMeasureId: l.unitOfMeasureId ?? null,
      })),
      createdAt: po.createdAt,
      updatedAt: po.updatedAt,
    };
  }
}
