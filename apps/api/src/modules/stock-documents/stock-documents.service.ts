import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import {
  CreateStockDocumentDto, UpdateStockDocumentDto,
  StockDocumentResponseDto, PaginatedStockDocumentsDto,
} from './stock-documents.dto';

const DOC_STATUSES = ['DRAFT', 'CONFIRMED', 'CANCELLED'] as const;
type DocStatus = typeof DOC_STATUSES[number];

const DOC_TRANSITIONS: Record<DocStatus, DocStatus[]> = {
  DRAFT:     ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: [],
  CANCELLED: [],
};

const MOVEMENT_TYPES: Record<string, string> = {
  WRITEOFF:        'WRITEOFF',
  TRANSFER:        'TRANSFER',
  OPENING_BALANCE: 'OPENING_BALANCE',
};

@Injectable()
export class StockDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  async findAll(orgId: string, page = 1, limit = 20, type?: string, status?: string): Promise<PaginatedStockDocumentsDto> {
    const where: any = { orgId, deletedAt: null };
    if (type) where.type = type;
    if (status) where.status = status;

    const skip = (page - 1) * limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.stockDocument.findMany({
        where, skip, take: limit, orderBy: { createdAt: 'desc' },
        include: {
          branch: { select: { name: true } },
          warehouse: { select: { name: true } },
          targetWarehouse: { select: { name: true } },
          lines: { where: { deletedAt: null }, include: { good: { select: { name: true, sku: true, unit: true } } } },
        },
      }),
      this.prisma.stockDocument.count({ where }),
    ]);

    return { items: items.map(this.toDto), total, page, limit };
  }

  async findOne(orgId: string, id: string): Promise<StockDocumentResponseDto> {
    const doc = await this.prisma.stockDocument.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        branch: { select: { name: true } },
        warehouse: { select: { name: true } },
        targetWarehouse: { select: { name: true } },
        lines: { include: { good: { select: { name: true, sku: true, unit: true } } } },
      },
    });
    if (!doc) throw new NotFoundException('Документ не знайдено');
    return this.toDto(doc);
  }

  async create(orgId: string, dto: CreateStockDocumentDto): Promise<StockDocumentResponseDto> {
    const [branch, warehouse] = await Promise.all([
      this.prisma.garageBranch.findFirst({ where: { id: dto.branchId, orgId, deletedAt: null } }),
      this.prisma.warehouse.findFirst({ where: { id: dto.warehouseId, orgId, deletedAt: null } }),
    ]);
    if (!branch) throw new NotFoundException('Філію не знайдено');
    if (!warehouse) throw new NotFoundException('Склад не знайдено');

    if (dto.type === 'TRANSFER' && !dto.targetWarehouseId) {
      throw new BadRequestException('Для переміщення потрібен склад призначення');
    }
    if (dto.targetWarehouseId) {
      const target = await this.prisma.warehouse.findFirst({ where: { id: dto.targetWarehouseId, orgId, deletedAt: null } });
      if (!target) throw new NotFoundException('Склад призначення не знайдено');
      if (dto.targetWarehouseId === dto.warehouseId) {
        throw new BadRequestException('Склад джерела і призначення не можуть збігатись');
      }
    }

    const count = await this.prisma.stockDocument.count({ where: { orgId } });
    const prefix = dto.type === 'WRITEOFF' ? 'WO' : dto.type === 'TRANSFER' ? 'TR' : 'OB';
    const number = `${prefix}-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;

    const lines = dto.lines ?? [];

    const doc = await this.prisma.$transaction(async (tx) => {
      const created = await tx.stockDocument.create({
        data: {
          orgId, branchId: dto.branchId, warehouseId: dto.warehouseId,
          targetWarehouseId: dto.targetWarehouseId ?? null,
          type: dto.type as any, number, notes: dto.notes,
        },
      });
      if (lines.length) {
        await tx.stockDocumentLine.createMany({
          data: lines.map(l => ({
            orgId, stockDocumentId: created.id,
            goodId: l.goodId, quantity: l.quantity, price: l.price ?? null,
          })),
        });
      }
      return tx.stockDocument.findFirstOrThrow({
        where: { id: created.id },
        include: {
          branch: { select: { name: true } },
          warehouse: { select: { name: true } },
          targetWarehouse: { select: { name: true } },
          lines: { where: { deletedAt: null }, include: { good: { select: { name: true, sku: true, unit: true } } } },
        },
      });
    });

    return this.toDto(doc);
  }

  async update(orgId: string, id: string, dto: UpdateStockDocumentDto): Promise<StockDocumentResponseDto> {
    const doc = await this.prisma.stockDocument.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!doc) throw new NotFoundException('Документ не знайдено');
    if (doc.status !== 'DRAFT') throw new BadRequestException('Редагувати можна лише чернетку');

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.lines !== undefined) {
        await tx.stockDocumentLine.updateMany({
          where: { stockDocumentId: id },
          data: { deletedAt: new Date() },
        });
        if (dto.lines.length) {
          await tx.stockDocumentLine.createMany({
            data: dto.lines.map(l => ({
              orgId, stockDocumentId: id,
              goodId: l.goodId, quantity: l.quantity, price: l.price ?? null,
            })),
          });
        }
      }
      return tx.stockDocument.update({
        where: { id },
        data: { notes: dto.notes },
        include: {
          branch: { select: { name: true } },
          warehouse: { select: { name: true } },
          targetWarehouse: { select: { name: true } },
          lines: { where: { deletedAt: null }, include: { good: { select: { name: true, sku: true, unit: true } } } },
        },
      });
    });

    return this.toDto(updated);
  }

  async transition(orgId: string, id: string, newStatus: DocStatus, userId?: string): Promise<StockDocumentResponseDto> {
    const doc = await this.prisma.stockDocument.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { lines: { where: { deletedAt: null } } },
    });
    if (!doc) throw new NotFoundException('Документ не знайдено');

    const allowed = DOC_TRANSITIONS[doc.status as DocStatus] ?? [];
    if (!allowed.includes(newStatus)) {
      throw new BadRequestException(`Перехід зі статусу "${doc.status}" в "${newStatus}" неможливий`);
    }

    if (newStatus === 'CONFIRMED') {
      if (!doc.lines.length) {
        throw new BadRequestException('Документ не може бути підтверджено без позицій');
      }

      await this.prisma.$transaction(async (tx) => {
        const movType = MOVEMENT_TYPES[doc.type];

        for (const line of doc.lines) {
          if (doc.type === 'TRANSFER') {
            // Write off from source
            await this.inventory.createMovement(orgId, {
              goodId: line.goodId,
              warehouseId: doc.warehouseId,
              type: 'WRITEOFF',
              quantity: -line.quantity,
              price: line.price ? Number(line.price) : undefined,
              documentType: 'StockDocument',
              documentId: id,
              createdBy: userId,
            }, tx);
            // Receipt at target
            await this.inventory.createMovement(orgId, {
              goodId: line.goodId,
              warehouseId: doc.targetWarehouseId!,
              type: 'RECEIPT',
              quantity: line.quantity,
              price: line.price ? Number(line.price) : undefined,
              documentType: 'StockDocument',
              documentId: id,
              createdBy: userId,
            }, tx);
          } else {
            const quantity = doc.type === 'WRITEOFF' ? -line.quantity : line.quantity;
            await this.inventory.createMovement(orgId, {
              goodId: line.goodId,
              warehouseId: doc.warehouseId,
              type: movType as any,
              quantity,
              price: line.price ? Number(line.price) : undefined,
              documentType: 'StockDocument',
              documentId: id,
              createdBy: userId,
            }, tx);
          }
        }

        await tx.stockDocument.update({
          where: { id },
          data: { status: 'CONFIRMED', confirmedAt: new Date(), confirmedBy: userId ?? null },
        });
      });
    } else {
      await this.prisma.stockDocument.update({ where: { id }, data: { status: newStatus } });
    }

    return this.findOne(orgId, id);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const doc = await this.prisma.stockDocument.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!doc) throw new NotFoundException('Документ не знайдено');
    if (doc.status !== 'DRAFT') throw new BadRequestException('Видалити можна лише чернетку');
    await this.prisma.stockDocument.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  private toDto(doc: any): StockDocumentResponseDto {
    return {
      id: doc.id, orgId: doc.orgId, number: doc.number,
      type: doc.type, status: doc.status,
      branchId: doc.branchId, branchName: doc.branch?.name,
      warehouseId: doc.warehouseId, warehouseName: doc.warehouse?.name,
      targetWarehouseId: doc.targetWarehouseId ?? null,
      targetWarehouseName: doc.targetWarehouse?.name ?? null,
      notes: doc.notes ?? null,
      confirmedAt: doc.confirmedAt ?? null,
      lines: (doc.lines ?? []).map((l: any) => ({
        id: l.id, goodId: l.goodId,
        goodName: l.good?.name, goodSku: l.good?.sku ?? null, unit: l.good?.unit,
        quantity: l.quantity, price: l.price != null ? Number(l.price) : null,
      })),
      createdAt: doc.createdAt, updatedAt: doc.updatedAt,
    };
  }
}
