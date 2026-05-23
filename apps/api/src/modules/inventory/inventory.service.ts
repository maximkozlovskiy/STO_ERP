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

    if (dto.quantity < 0 || dto.type === 'RESERVATION_RELEASE') {
      const item = await db.stockItem.findUnique({
        where: { orgId_goodId_warehouseId: { orgId, goodId: dto.goodId, warehouseId: dto.warehouseId } },
      });
      const available = item ? (item.quantity - item.reserved) : 0;
      if (dto.quantity < 0 && available < Math.abs(dto.quantity)) {
        throw new BadRequestException('Недостатньо товару на складі');
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

    const quantityDelta = dto.type === 'RESERVATION' ? 0 : dto.quantity;
    const reservedDelta =
      dto.type === 'RESERVATION' ? dto.quantity :
      dto.type === 'RESERVATION_RELEASE' ? dto.quantity : // negative to subtract
      dto.type === 'WRITEOFF' ? 0 : // reservation already covers it
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
}
