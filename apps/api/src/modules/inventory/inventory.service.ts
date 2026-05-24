import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface CreateMovementDto {
  goodId: string;
  warehouseId: string;
  type: StockMovementType;
  quantity: number; // positive = in, negative = out
  price?: number;
  documentType?: string;
  documentId?: string;
  notes?: string;
  createdBy?: string;
}

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async createMovement(orgId: string, dto: CreateMovementDto, tx?: Prisma.TransactionClient): Promise<void> {
    if (dto.quantity === 0) throw new BadRequestException('Кількість не може бути нульовою');
    if (dto.type === 'RESERVATION_RELEASE' && dto.quantity > 0) {
      throw new BadRequestException('Зняття резерву: кількість повинна бути від\'ємною');
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

    await db.stockMovement.create({
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
    // Use raw query for cross-field comparison (quantity <= min_stock) — Prisma doesn't support it in where
    const rows = await this.prisma.$queryRaw<Array<{
      good_id: string; good_name: string; good_sku: string | null; unit: string;
      warehouse_name: string; quantity: number; min_stock: number;
    }>>`
      SELECT
        si.good_id,
        g.name AS good_name,
        g.sku  AS good_sku,
        g.unit,
        w.name AS warehouse_name,
        si.quantity,
        si.min_stock
      FROM stock_items si
      JOIN goods g ON g.id = si.good_id
      JOIN warehouses w ON w.id = si.warehouse_id
      WHERE si.org_id = ${orgId}::uuid
        AND si.deleted_at IS NULL
        AND g.deleted_at IS NULL
        AND w.deleted_at IS NULL
        AND si.min_stock IS NOT NULL
        AND si.quantity <= si.min_stock
      ORDER BY w.name, g.name
    `;

    return rows.map(r => ({
      goodId: r.good_id,
      goodName: r.good_name,
      goodSku: r.good_sku,
      unit: r.unit,
      warehouseName: r.warehouse_name,
      quantity: r.quantity,
      minStock: r.min_stock,
      deficit: r.min_stock - r.quantity,
    }));
  }
}
