import { Injectable, BadRequestException, Inject, forwardRef } from '@nestjs/common';
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
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => BatchService)) private readonly batchService: BatchService,
  ) {}

  async createMovement(orgId: string, dto: CreateMovementDto, tx?: Prisma.TransactionClient): Promise<void> {
    if (dto.quantity === 0) throw new BadRequestException('Кількість не може бути нульовою');
    if (dto.type === 'RESERVATION_RELEASE' && dto.quantity > 0) {
      throw new BadRequestException('Зняття резерву: кількість повинна бути від\'ємною');
    }
    // Bug #15: RECEIPT з quantity > 0 завжди створює StockBatch. Якщо ціна відсутня —
    // батч-tracking зламається, бо consumeBatch у режимі FIFO/LIFO/FEFO не знайде партії.
    // Дозволяємо price=0 (безкоштовні зразки) — для них батч створиться з нульовою собівартістю.
    if (dto.type === 'RECEIPT' && dto.quantity > 0 && (dto.price === undefined || dto.price === null)) {
      throw new BadRequestException('Ціна оприбуткування обов\'язкова для створення партії');
    }
    const db = tx ?? this.prisma;

    if (dto.quantity < 0 || dto.type === 'RESERVATION' || dto.type === 'RESERVATION_RELEASE') {
      const item = await db.stockItem.findFirst({
        where: { orgId, goodId: dto.goodId, warehouseId: dto.warehouseId, deletedAt: null },
      });
      const quantity = item?.quantity ?? 0;
      const reserved = item?.reserved ?? 0;
      const available = quantity - reserved;
      if (dto.quantity < 0 && dto.type !== 'RESERVATION_RELEASE' && available < Math.abs(dto.quantity)) {
        throw new BadRequestException('Недостатньо товару на складі');
      }
      if (dto.type === 'RESERVATION' && dto.quantity > available) {
        throw new BadRequestException('Недостатньо доступного товару для резервування');
      }
      if (dto.type === 'RESERVATION_RELEASE' && Math.abs(dto.quantity) > reserved) {
        throw new BadRequestException('Неможливо зняти резерв: зарезервована кількість менша за запитану');
      }
    }

    const movement = await db.stockMovement.create({
      data: {
        orgId,
        goodId: dto.goodId,
        warehouseId: dto.warehouseId,
        type: dto.type,
        quantity: dto.quantity,
        price: dto.price ?? null,
        documentType: dto.documentType ?? null,
        documentId: dto.documentId ?? null,
        notes: dto.notes ?? null,
        createdBy: dto.createdBy ?? null,
      },
    });

    // Create batch on RECEIPT (price can be 0 for free samples; undefined was rejected above)
    if (dto.type === 'RECEIPT' && dto.quantity > 0) {
      await this.batchService.createFromReceipt(orgId, {
        goodId: dto.goodId,
        warehouseId: dto.warehouseId,
        purchaseOrderLineId: dto.purchaseOrderLineId,
        stockMovementId: movement.id,
        batchNumber: dto.batchNumber,
        expiryDate: dto.expiryDate,
        receivedQty: dto.quantity,
        costPrice: dto.price ?? 0,
      }, db as Prisma.TransactionClient);
    }

    // RESERVATION/RESERVATION_RELEASE only affect reserved counter, not physical quantity
    // WRITEOFF decrements quantity; reserved was already decremented by the prior RESERVATION_RELEASE call
    const quantityDelta =
      dto.type === 'RESERVATION' || dto.type === 'RESERVATION_RELEASE' ? 0 : dto.quantity;
    const reservedDelta =
      dto.type === 'RESERVATION' ? dto.quantity :           // positive → increases reserved
      dto.type === 'RESERVATION_RELEASE' ? dto.quantity :   // negative → decreases reserved
      0;

    await db.stockItem.upsert({
      where: { orgId_goodId_warehouseId: { orgId, goodId: dto.goodId, warehouseId: dto.warehouseId } },
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

  async getStockLevel(orgId: string, goodId: string, warehouseId: string): Promise<{ quantity: number; reserved: number; available: number }> {
    const item = await this.prisma.stockItem.findFirst({
      where: { orgId, goodId, warehouseId, deletedAt: null },
    });
    const quantity = item ? item.quantity : 0;
    const reserved = item ? item.reserved : 0;
    return { quantity, reserved, available: quantity - reserved };
  }

  async findStockItems(orgId: string, warehouseId?: string, goodId?: string, q?: string) {
    const where: Prisma.StockItemWhereInput = { orgId, deletedAt: null };
    if (warehouseId) where.warehouseId = warehouseId;
    if (goodId) where.goodId = goodId;
    if (q) where.good = { name: { contains: q, mode: 'insensitive' } };

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
    const rows = await this.prisma.$queryRaw<Array<{
      goodId: string; goodName: string; goodSku: string | null; unit: string;
      warehouseName: string; quantity: number; minStock: number;
    }>>`
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
}
