import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma, PurchaseOrderStatus } from '@prisma/client';

import { kyivToday } from '../../common/utils/kyiv-date';
import { assertFsmTransition } from '../../common/utils/fsm';
import { safeCoeff } from '../../common/utils/math';
import { calculatePagination } from '../../common/utils/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { formatPersonName, TRANSACTION_TIMEOUT_MS, MAX_QUERY_LIMIT } from '@sto/shared';
import { DocumentNumberService } from '../document-number/document-number.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { PricingService } from '../inventory/pricing.service';
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
    const [items, total] = await this.prisma.$transaction([
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
                sku: true,
                unit: true,
                unitOfMeasure: { select: { shortName: true, coefficient: true } },
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
    const [supplier, warehouse] = await Promise.all([
      this.prisma.counterparty.findFirst({ where: { id: dto.supplierId, orgId, deletedAt: null } }),
      this.prisma.warehouse.findFirst({ where: { id: dto.warehouseId, orgId, deletedAt: null } }),
    ]);
    if (!supplier) throw new NotFoundException('Постачальника не знайдено');
    if (!warehouse) throw new NotFoundException('Склад не знайдено');

    // Auto-select primary PURCHASE contract if not provided. When the client
    // supplies a contractId, validate it belongs to the same org + supplier +
    // PURCHASE type to prevent cross-tenant FK attacks (Bug review §2.2).
    let contractId = dto.contractId ?? null;
    if (contractId) {
      const provided = await this.prisma.counterpartyContract.findFirst({
        where: {
          id: contractId,
          orgId,
          counterpartyId: dto.supplierId,
          contractType: 'PURCHASE',
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!provided) throw new NotFoundException('Договір не знайдено');
    } else {
      const primaryContract = await this.prisma.counterpartyContract.findFirst({
        where: {
          counterpartyId: dto.supplierId,
          orgId,
          contractType: 'PURCHASE',
          deletedAt: null,
        },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        select: { id: true },
      });
      contractId = primaryContract?.id ?? null;
    }

    const number = await this.docNumbers.next(orgId, 'PURCHASE_ORDER');

    const lines = dto.lines ?? [];
    const totalAmount = lines.reduce((s, l) => s + l.quantity * l.price, 0);

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
            documentDate: dto.documentDate ? new Date(dto.documentDate) : kyivToday(),
          },
        });
        if (lines.length) {
          await tx.purchaseOrderLine.createMany({
            data: lines.map(l => ({
              orgId,
              purchaseOrderId: created.id,
              goodId: l.goodId,
              quantity: l.quantity,
              price: l.price,
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
                    sku: true,
                    unit: true,
                    unitOfMeasure: { select: { shortName: true, coefficient: true } },
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
    // коли dto.lines не передано). Раніше тягнуло supplierId/warehouseId/notes/documentDate +
    // syncVersion/orgId/deletedAt + 8 інших колонок які ігноруються.
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true, totalAmount: true },
    });
    if (!po) throw new NotFoundException('Замовлення не знайдено');
    if (po.status !== PurchaseOrderStatus.DRAFT)
      throw new BadRequestException('Редагувати можна лише чернетку');

    const lines = dto.lines;
    const totalAmount = lines
      ? lines.reduce((s, l) => s + l.quantity * l.price, 0)
      : Number(po.totalAmount);

    const updated = await this.prisma.$transaction(
      async tx => {
        if (lines !== undefined) {
          await tx.purchaseOrderLine.updateMany({
            where: { purchaseOrderId: id, orgId },
            data: { deletedAt: new Date() },
          });
          if (lines.length) {
            await tx.purchaseOrderLine.createMany({
              data: lines.map(l => ({
                orgId,
                purchaseOrderId: id,
                goodId: l.goodId,
                quantity: l.quantity,
                price: l.price,
              })),
            });
          }
        }
        return tx.purchaseOrder.update({
          where: { id, orgId },
          data: {
            notes: dto.notes,
            totalAmount,
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
                    sku: true,
                    unit: true,
                    unitOfMeasure: { select: { shortName: true, coefficient: true } },
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

    let receivedAmount = 0;

    await this.prisma.$transaction(
      async tx => {
        for (const recv of dto.lines) {
          const line = po.lines.find(l => l.id === recv.lineId);
          if (!line) continue;
          if (recv.receivedQty <= 0) continue;

          // Prefer caller-provided UoM override (already validated against orgId above);
          // fall back to Good.unitId, then null (backward compat with nullable column).
          const resolvedUomId =
            (recv.unitOfMeasureId && allowedUomIds.has(recv.unitOfMeasureId)
              ? recv.unitOfMeasureId
              : null) ??
            line.good?.unitId ??
            null;

          await this.inventory.createMovement(
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
          );

          // Bug #237: avoid overwriting an existing PO line UoM on subsequent partial
          // receives. Only persist UoM when (a) this is the first receive (no prior qty),
          // or (b) the caller passed an explicit override — otherwise keep the original.
          const shouldUpdateLineUom = line.receivedQty === 0 || !!recv.unitOfMeasureId;
          await tx.purchaseOrderLine.update({
            where: { id: recv.lineId, orgId },
            data: {
              receivedQty: { increment: recv.receivedQty },
              ...(shouldUpdateLineUom ? { unitOfMeasureId: resolvedUomId } : {}),
            },
          });

          receivedAmount += recv.receivedQty * Number(line.price);
        }

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
        lines: {
          where: { deletedAt: null },
          select: {
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
      goodId: string;
      goodName: string;
      costPrice: number;
      oldSalePrice: number;
      newSalePrice: number;
    };
    const plan: Plan[] = [];

    for (const line of po.lines) {
      if (!line.good) continue;
      const costPrice = Number(line.price);
      const oldSalePrice = Number(line.good.salePrice);
      const newSalePrice = this.pricingService.computePriceFromRules(
        rules,
        line.goodId,
        line.good.category ?? undefined,
        line.good.goodType ?? undefined,
        line.good.brandId ?? undefined,
        costPrice,
      );
      if (Math.abs(newSalePrice - oldSalePrice) < 0.001) continue;
      plan.push({
        goodId: line.goodId,
        goodName: line.good.name,
        costPrice,
        oldSalePrice,
        newSalePrice,
      });
    }

    if (plan.length === 0) return { updated: 0, details: [] };

    // Batch у chunks по 100 щоб не лочити велику кількість рядків у одній tx;
    // explicit { timeout: 10_000 } — array-form $transaction default 5s не вистачає на 100 рядків.
    const CHUNK = 100;
    for (let i = 0; i < plan.length; i += CHUNK) {
      const chunk = plan.slice(i, i + CHUNK);
      await this.prisma.$transaction(
        async tx => {
          for (const u of chunk) {
            // Bug #191: updateMany з orgId — defense-in-depth tenant guard
            // (u.goodId уже org-trusted через po.lines, але дублюємо щоб патерн був безпечним для копіювання)
            await tx.good.updateMany({
              where: { id: u.goodId, orgId, deletedAt: null },
              data: { salePrice: u.newSalePrice },
            });
          }
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

    return { updated: plan.length, details: plan };
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
    notes: string | null;
    documentDate?: Date | null;
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
      receivedQty: number;
      unitOfMeasureId?: string | null;
      good: {
        name: string;
        sku: string | null;
        unit: string;
        unitOfMeasure: { shortName: string; coefficient: number } | null;
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
      notes: po.notes ?? null,
      documentDate: po.documentDate ? po.documentDate.toISOString().slice(0, 10) : null,
      linesCount: po._count?.lines ?? po.lines?.length ?? 0,
      deletedAt: po.deletedAt ?? null,
      lines: (po.lines ?? []).map(l => ({
        id: l.id,
        goodId: l.goodId,
        goodName: l.good?.name,
        goodSku: l.good?.sku ?? null,
        unit: l.good?.unit,
        unitShortName: l.good?.unitOfMeasure?.shortName ?? l.good?.unit,
        // Bug #316: safeCoeff() ловить legacy/seed coefficient=0/NaN/негативні —
        // фронт використовує coefficient як дільник для display↔base conversion.
        coefficient: safeCoeff(l.good?.unitOfMeasure?.coefficient),
        quantity: l.quantity,
        price: Number(l.price),
        amount: l.quantity * Number(l.price),
        receivedQty: l.receivedQty,
        unitOfMeasureId: l.unitOfMeasureId ?? null,
      })),
      createdAt: po.createdAt,
      updatedAt: po.updatedAt,
    };
  }
}
