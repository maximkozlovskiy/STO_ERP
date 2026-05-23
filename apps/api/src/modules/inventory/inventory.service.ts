import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StockMovementType } from '@prisma/client';

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

  async createMovement(orgId: string, dto: CreateMovementDto, tx?: any): Promise<void> {
    const db = tx ?? this.prisma;

    if (dto.quantity < 0 || dto.type === 'RESERVATION' || dto.type === 'RESERVATION_RELEASE') {
      const item = await db.stockItem.findUnique({
        where: { orgId_goodId_warehouseId: { orgId, goodId: dto.goodId, warehouseId: dto.warehouseId } },
      });
      const quantity = item?.quantity ?? 0;
      const reserved = item?.reserved ?? 0;
      const available = quantity - reserved;
      if (dto.quantity < 0 && available < Math.abs(dto.quantity)) {
        throw new BadRequestException('Недостатньо товару на складі');
      }
      if (dto.type === 'RESERVATION' && dto.quantity > available) {
        throw new BadRequestException('Недостатньо доступного товару для резервування');
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
    const item = await this.prisma.stockItem.findUnique({
      where: { orgId_goodId_warehouseId: { orgId, goodId, warehouseId } },
    });
    const quantity = item ? item.quantity : 0;
    const reserved = item ? item.reserved : 0;
    return { quantity, reserved, available: quantity - reserved };
  }

  async findStockItems(orgId: string, warehouseId?: string, goodId?: string, q?: string) {
    const where: any = { orgId, deletedAt: null };
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
    // Prisma doesn't support cross-field comparisons, so load items with minStock set and filter in JS
    const items = await this.prisma.stockItem.findMany({
      where: { orgId, deletedAt: null, minStock: { not: null } },
      include: {
        good: { select: { id: true, name: true, sku: true, unit: true } },
        warehouse: { select: { id: true, name: true } },
      },
    });

    return items
      .filter(i => i.quantity <= (i.minStock ?? 0))
      .map(i => ({
        goodId: i.goodId,
        goodName: i.good.name,
        goodSku: i.good.sku,
        unit: i.good.unit,
        warehouseName: i.warehouse.name,
        quantity: i.quantity,
        minStock: i.minStock,
        deficit: (i.minStock ?? 0) - i.quantity,
      }));
  }
}
