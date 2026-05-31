import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BatchService } from './batch.service';

export interface CreateMovementDto {
  goodId: string;
  warehouseId: string;
  type: StockMovementType;
  quantity: number; // positive = in, negative = out
  price?: number;
  documentType?: string;
  documentId?: string;
  documentLineId?: string;
  notes?: string;
  createdBy?: string;
  // Batch fields (optional, used when type=RECEIPT)
  purchaseOrderLineId?: string;
  batchNumber?: string;
  expiryDate?: Date;
  unitOfMeasureId?: string | null;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => BatchService)) private readonly batchService: BatchService,
  ) {}

  async createMovement(
    orgId: string,
    dto: CreateMovementDto,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (dto.quantity === 0) throw new BadRequestException('Кількість не може бути нульовою');
    if (!Number.isFinite(dto.quantity)) {
      throw new BadRequestException('Невірне значення кількості');
    }
    if (dto.price !== undefined && dto.price !== null && !Number.isFinite(dto.price)) {
      throw new BadRequestException('Невірне значення ціни');
    }
    if (dto.type === 'RESERVATION_RELEASE' && dto.quantity > 0) {
      throw new BadRequestException("Зняття резерву: кількість повинна бути від'ємною");
    }
    const db = tx ?? this.prisma;

    // Bug #15 + Bug #26: RECEIPT з quantity > 0 завжди створює StockBatch. Якщо ціна
    // відсутня (типове для TRANSFER або інвентаризаційного оприбуткування) — fallback
    // на good.purchasePrice, інакше 0 (безкоштовні зразки). Це зберігає батч-tracking
    // без блокування легітимних бізнес-операцій.
    let resolvedCostPrice: number | null = dto.price ?? null;
    if (dto.type === 'RECEIPT' && dto.quantity > 0 && resolvedCostPrice === null) {
      const good = await db.good.findFirst({
        where: { id: dto.goodId, orgId, deletedAt: null },
        select: { purchasePrice: true },
      });
      resolvedCostPrice = good?.purchasePrice != null ? Number(good.purchasePrice) : 0;
    }

    if (dto.quantity < 0 || dto.type === 'RESERVATION' || dto.type === 'RESERVATION_RELEASE') {
      const item = await db.stockItem.findFirst({
        where: { orgId, goodId: dto.goodId, warehouseId: dto.warehouseId, deletedAt: null },
      });
      const quantity = item?.quantity ?? 0;
      const reserved = item?.reserved ?? 0;
      const available = quantity - reserved;
      if (
        dto.quantity < 0 &&
        dto.type !== 'RESERVATION_RELEASE' &&
        available < Math.abs(dto.quantity)
      ) {
        throw new BadRequestException('Недостатньо товару на складі');
      }
      if (dto.type === 'RESERVATION' && dto.quantity > available) {
        throw new BadRequestException('Недостатньо доступного товару для резервування');
      }
      if (dto.type === 'RESERVATION_RELEASE' && Math.abs(dto.quantity) > reserved) {
        throw new BadRequestException(
          'Неможливо зняти резерв: зарезервована кількість менша за запитану',
        );
      }
    }

    const movement = await db.stockMovement.create({
      data: {
        orgId,
        goodId: dto.goodId,
        warehouseId: dto.warehouseId,
        type: dto.type,
        quantity: dto.quantity,
        price: dto.price ?? resolvedCostPrice,
        documentType: dto.documentType ?? null,
        documentId: dto.documentId ?? null,
        notes: dto.notes ?? null,
        createdBy: dto.createdBy ?? null,
        unitOfMeasureId: dto.unitOfMeasureId ?? null,
      },
    });

    // Create batch on RECEIPT. resolvedCostPrice = dto.price ?? good.purchasePrice ?? 0.
    if (dto.type === 'RECEIPT' && dto.quantity > 0) {
      await this.batchService.createFromReceipt(
        orgId,
        {
          goodId: dto.goodId,
          warehouseId: dto.warehouseId,
          purchaseOrderLineId: dto.purchaseOrderLineId,
          stockMovementId: movement.id,
          batchNumber: dto.batchNumber,
          expiryDate: dto.expiryDate,
          receivedQty: dto.quantity,
          costPrice: resolvedCostPrice ?? 0,
          unitOfMeasureId: dto.unitOfMeasureId ?? null,
        },
        db as Prisma.TransactionClient,
      );
    }

    // RESERVATION/RESERVATION_RELEASE only affect reserved counter, not physical quantity
    // WRITEOFF decrements quantity; reserved was already decremented by the prior RESERVATION_RELEASE call
    const quantityDelta =
      dto.type === 'RESERVATION' || dto.type === 'RESERVATION_RELEASE' ? 0 : dto.quantity;
    const reservedDelta =
      dto.type === 'RESERVATION'
        ? dto.quantity // positive → increases reserved
        : dto.type === 'RESERVATION_RELEASE'
          ? dto.quantity // negative → decreases reserved
          : 0;

    await db.stockItem.upsert({
      where: {
        orgId_goodId_warehouseId: { orgId, goodId: dto.goodId, warehouseId: dto.warehouseId },
      },
      update: {
        quantity: { increment: quantityDelta },
        reserved: { increment: reservedDelta },
        // Ensure soft-deleted items are restored when a movement re-creates them
        deletedAt: null,
      },
      create: {
        orgId,
        goodId: dto.goodId,
        warehouseId: dto.warehouseId,
        quantity: quantityDelta,
        reserved: Math.max(0, reservedDelta),
      },
    });
  }

  async getStockLevel(
    orgId: string,
    goodId: string,
    warehouseId: string,
  ): Promise<{ quantity: number; reserved: number; available: number }> {
    const item = await this.prisma.stockItem.findFirst({
      where: { orgId, goodId, warehouseId, deletedAt: null },
    });
    const quantity = item ? item.quantity : 0;
    const reserved = item ? item.reserved : 0;
    return { quantity, reserved, available: quantity - reserved };
  }

  async findStockItems(orgId: string, warehouseId?: string, goodId?: string, q?: string) {
    // Bug #34: relation-фільтри `good`/`warehouse` повинні відсікати soft-deleted сутності,
    // щоб список інвентаря не показував позиції з видаленими товарами/складами
    // (узгоджується з `findLowStockItems` нижче, який це робить через raw SQL).
    const where: Prisma.StockItemWhereInput = {
      orgId,
      deletedAt: null,
      good: q
        ? { deletedAt: null, name: { contains: q, mode: 'insensitive' } }
        : { deletedAt: null },
      warehouse: { deletedAt: null },
    };
    if (warehouseId) where.warehouseId = warehouseId;
    if (goodId) where.goodId = goodId;

    const items = await this.prisma.stockItem.findMany({
      where,
      include: {
        good: { select: { id: true, name: true, sku: true, unit: true, salePrice: true } },
        warehouse: { select: { id: true, name: true } },
      },
      orderBy: [{ warehouse: { name: 'asc' } }, { good: { name: 'asc' } }],
      take: 500,
    });

    return items.map(i => ({
      id: i.id,
      goodId: i.goodId,
      goodName: i.good.name,
      goodSku: i.good.sku,
      unit: i.good.unit,
      salePrice: Number(i.good.salePrice),
      warehouseId: i.warehouseId,
      warehouseName: i.warehouse.name,
      quantity: i.quantity,
      reserved: i.reserved,
      available: i.quantity - i.reserved,
      minStock: i.minStock ?? null,
      isLow: i.minStock != null && i.quantity <= i.minStock,
    }));
  }

  async findLowStockItems(orgId: string) {
    // Use raw query for cross-field comparison (quantity <= minStock) — Prisma doesn't support it in where.
    // Prisma schema uses camelCase without @map, so Postgres columns are camelCase and require double quotes.
    const rows = await this.prisma.$queryRaw<
      Array<{
        goodId: string;
        goodName: string;
        goodSku: string | null;
        unit: string;
        warehouseName: string;
        quantity: number;
        minStock: number;
      }>
    >`
      SELECT
        si."goodId"     AS "goodId",
        g.name          AS "goodName",
        g.sku           AS "goodSku",
        g.unit          AS unit,
        w.name          AS "warehouseName",
        si.quantity     AS quantity,
        si."minStock"   AS "minStock"
      FROM stock_items si
      JOIN goods g ON g.id = si."goodId"
      JOIN warehouses w ON w.id = si."warehouseId"
      WHERE si."orgId" = ${orgId}::uuid
        AND si."deletedAt" IS NULL
        AND g."deletedAt" IS NULL
        AND w."deletedAt" IS NULL
        AND si."minStock" IS NOT NULL
        AND si.quantity <= si."minStock"
      ORDER BY w.name, g.name
      LIMIT 500
    `;

    return rows.map(r => ({
      goodId: r.goodId,
      goodName: r.goodName,
      goodSku: r.goodSku,
      unit: r.unit,
      warehouseName: r.warehouseName,
      quantity: r.quantity,
      minStock: r.minStock,
      deficit: r.minStock - r.quantity,
    }));
  }

  async updateMinStock(
    orgId: string,
    stockItemId: string,
    minStock: number | null,
  ): Promise<{ id: string; minStock: number | null }> {
    const item = await this.prisma.stockItem.findFirst({
      where: { id: stockItemId, orgId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Залишок не знайдено');
    const updated = await this.prisma.stockItem.update({
      where: { id: stockItemId },
      data: { minStock },
    });
    return { id: updated.id, minStock: updated.minStock ?? null };
  }
}
