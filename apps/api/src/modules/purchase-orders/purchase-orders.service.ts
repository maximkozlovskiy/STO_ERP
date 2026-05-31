import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma, PurchaseOrderStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { formatPersonName } from '@sto/shared';
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
  ): Promise<PaginatedPurchaseOrdersDto> {
    const where: Prisma.PurchaseOrderWhereInput = { orgId, deletedAt: null };
    if (status) where.status = status as POStatus;

    const skip = (page - 1) * limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.purchaseOrder.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        // Lines omitted from list — loaded on demand via findOne when detail opens.
        // Avoids fetching up to 1000 line rows × 20 POs per list request.
        include: {
          supplier: { select: { firstName: true, lastName: true, companyName: true } },
          warehouse: { select: { name: true } },
          _count: { select: { lines: { where: { deletedAt: null } } } },
        },
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);

    return {
      items: items.map(item => this.toDto(item as Parameters<typeof this.toDto>[0])),
      total,
      page,
      limit,
    };
  }

  async findOne(orgId: string, id: string): Promise<PurchaseOrderResponseDto> {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        supplier: { select: { firstName: true, lastName: true, companyName: true } },
        warehouse: { select: { name: true } },
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
            number,
            notes: dto.notes,
            totalAmount,
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
      { timeout: 5_000 },
    ); // Bug #132: explicit timeout

    return this.toDto(po);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdatePurchaseOrderDto,
  ): Promise<PurchaseOrderResponseDto> {
    const po = await this.prisma.purchaseOrder.findFirst({ where: { id, orgId, deletedAt: null } });
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
          data: { notes: dto.notes, totalAmount },
          include: {
            supplier: { select: { firstName: true, lastName: true, companyName: true } },
            warehouse: { select: { name: true } },
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
      { timeout: 5_000 },
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
        const po = await tx.purchaseOrder.findFirst({ where: { id, orgId, deletedAt: null } });
        if (!po) throw new NotFoundException('Замовлення не знайдено');

        const allowed = PO_TRANSITIONS[po.status as POStatus] ?? [];
        if (!allowed.includes(newStatus)) {
          throw new BadRequestException(
            `Перехід зі статусу "${po.status}" в "${newStatus}" неможливий`,
          );
        }

        await tx.purchaseOrder.update({ where: { id, orgId }, data: { status: newStatus } });
      },
      { timeout: 5_000 },
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
      include: { lines: { where: { deletedAt: null }, take: 1000 } },
    });
    if (!po) throw new NotFoundException('Замовлення не знайдено');
    if (po.status !== PurchaseOrderStatus.ORDERED && po.status !== PurchaseOrderStatus.PARTIAL) {
      throw new BadRequestException(
        'Прийом можливий лише для замовлень зі статусом ORDERED або PARTIAL',
      );
    }

    let receivedAmount = 0;

    await this.prisma.$transaction(
      async tx => {
        for (const recv of dto.lines) {
          const line = po.lines.find(l => l.id === recv.lineId);
          if (!line) continue;
          if (recv.receivedQty <= 0) continue;

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
            },
            tx,
          );

          await tx.purchaseOrderLine.update({
            where: { id: recv.lineId, orgId },
            data: { receivedQty: { increment: recv.receivedQty } },
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
      { timeout: 15_000 },
    ); // Bug #132: explicit timeout — N lines × createMovement (батч-tracking)
    return this.findOne(orgId, id);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const po = await this.prisma.purchaseOrder.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!po) throw new NotFoundException('Замовлення не знайдено');
    if (po.status !== PurchaseOrderStatus.DRAFT)
      throw new BadRequestException('Видалити можна лише чернетку');
    await this.prisma.purchaseOrder.update({
      where: { id, orgId },
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
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: poId, orgId, deletedAt: null },
      include: {
        lines: {
          where: { deletedAt: null },
          include: {
            good: { include: { brand: true } },
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
    totalAmount: import('@prisma/client').Prisma.Decimal;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
    supplier: {
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
    } | null;
    warehouse: { name: string } | null;
    lines?: Array<{
      id: string;
      goodId: string;
      quantity: number;
      price: import('@prisma/client').Prisma.Decimal;
      receivedQty: number;
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
      totalAmount: Number(po.totalAmount),
      notes: po.notes ?? null,
      linesCount: po._count?.lines ?? po.lines?.length ?? 0,
      lines: (po.lines ?? []).map(l => ({
        id: l.id,
        goodId: l.goodId,
        goodName: l.good?.name,
        goodSku: l.good?.sku ?? null,
        unit: l.good?.unit,
        unitShortName: l.good?.unitOfMeasure?.shortName ?? l.good?.unit,
        coefficient: l.good?.unitOfMeasure?.coefficient ?? 1,
        quantity: l.quantity,
        price: Number(l.price),
        amount: l.quantity * Number(l.price),
        receivedQty: l.receivedQty,
      })),
      createdAt: po.createdAt,
      updatedAt: po.updatedAt,
    };
  }
}
