import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import {
  CreatePurchaseOrderDto, UpdatePurchaseOrderDto,
  ReceivePurchaseOrderDto, PurchaseOrderResponseDto, PaginatedPurchaseOrdersDto,
} from './purchase-orders.dto';

const PO_STATUSES = ['DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED'] as const;
type POStatus = typeof PO_STATUSES[number];

const PO_TRANSITIONS: Record<POStatus, POStatus[]> = {
  DRAFT:     ['ORDERED', 'CANCELLED'],
  ORDERED:   ['PARTIAL', 'RECEIVED', 'CANCELLED'],
  PARTIAL:   ['RECEIVED', 'CANCELLED'],
  RECEIVED:  [],
  CANCELLED: [],
};

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly settlements: SettlementsService,
  ) {}

  async findAll(orgId: string, page = 1, limit = 20, status?: string): Promise<PaginatedPurchaseOrdersDto> {
    const where: any = { orgId, deletedAt: null };
    if (status) where.status = status;

    const skip = (page - 1) * limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.purchaseOrder.findMany({
        where, skip, take: limit, orderBy: { createdAt: 'desc' },
        include: {
          supplier: { select: { firstName: true, lastName: true, companyName: true } },
          warehouse: { select: { name: true } },
          lines: { include: { good: { select: { name: true, sku: true, unit: true } } } },
        },
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);

    return { items: items.map(this.toDto), total, page, limit };
  }

  async findOne(orgId: string, id: string): Promise<PurchaseOrderResponseDto> {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        supplier: { select: { firstName: true, lastName: true, companyName: true } },
        warehouse: { select: { name: true } },
        lines: { include: { good: { select: { name: true, sku: true, unit: true } } } },
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

    const count = await this.prisma.purchaseOrder.count({ where: { orgId } });
    const number = `PO-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;

    const lines = dto.lines ?? [];
    const totalAmount = lines.reduce((s, l) => s + l.quantity * l.price, 0);

    const po = await this.prisma.$transaction(async (tx) => {
      const created = await tx.purchaseOrder.create({
        data: { orgId, supplierId: dto.supplierId, warehouseId: dto.warehouseId, number, notes: dto.notes, totalAmount },
      });
      if (lines.length) {
        await tx.purchaseOrderLine.createMany({
          data: lines.map(l => ({ purchaseOrderId: created.id, goodId: l.goodId, quantity: l.quantity, price: l.price })),
        });
      }
      return tx.purchaseOrder.findFirstOrThrow({
        where: { id: created.id },
        include: {
          supplier: { select: { firstName: true, lastName: true, companyName: true } },
          warehouse: { select: { name: true } },
          lines: { include: { good: { select: { name: true, sku: true, unit: true } } } },
        },
      });
    });

    return this.toDto(po);
  }

  async update(orgId: string, id: string, dto: UpdatePurchaseOrderDto): Promise<PurchaseOrderResponseDto> {
    const po = await this.prisma.purchaseOrder.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!po) throw new NotFoundException('Замовлення не знайдено');
    if (po.status !== 'DRAFT') throw new BadRequestException('Редагувати можна лише чернетку');

    const lines = dto.lines;
    const totalAmount = lines ? lines.reduce((s, l) => s + l.quantity * l.price, 0) : Number(po.totalAmount);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (lines !== undefined) {
        await tx.purchaseOrderLine.updateMany({
          where: { purchaseOrderId: id },
          data: { deletedAt: new Date() },
        });
        if (lines.length) {
          await tx.purchaseOrderLine.createMany({
            data: lines.map(l => ({ purchaseOrderId: id, goodId: l.goodId, quantity: l.quantity, price: l.price })),
          });
        }
      }
      return tx.purchaseOrder.update({
        where: { id },
        data: { notes: dto.notes, totalAmount },
        include: {
          supplier: { select: { firstName: true, lastName: true, companyName: true } },
          warehouse: { select: { name: true } },
          lines: { include: { good: { select: { name: true, sku: true, unit: true } } } },
        },
      });
    });

    return this.toDto(updated);
  }

  async transition(orgId: string, id: string, newStatus: POStatus): Promise<PurchaseOrderResponseDto> {
    const po = await this.prisma.purchaseOrder.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!po) throw new NotFoundException('Замовлення не знайдено');

    const allowed = PO_TRANSITIONS[po.status as POStatus] ?? [];
    if (!allowed.includes(newStatus)) {
      throw new BadRequestException(`Перехід зі статусу "${po.status}" в "${newStatus}" неможливий`);
    }

    await this.prisma.purchaseOrder.update({ where: { id }, data: { status: newStatus } });
    return this.findOne(orgId, id);
  }

  async receive(orgId: string, id: string, dto: ReceivePurchaseOrderDto, userId?: string): Promise<PurchaseOrderResponseDto> {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { lines: true },
    });
    if (!po) throw new NotFoundException('Замовлення не знайдено');
    if (!['ORDERED', 'PARTIAL'].includes(po.status)) {
      throw new BadRequestException('Прийом можливий лише для замовлень зі статусом ORDERED або PARTIAL');
    }

    await this.prisma.$transaction(async (tx) => {
      for (const recv of dto.lines) {
        const line = po.lines.find(l => l.id === recv.lineId);
        if (!line) continue;
        if (recv.receivedQty <= 0) continue;

        await this.inventory.createMovement(orgId, {
          goodId: line.goodId,
          warehouseId: po.warehouseId,
          type: 'RECEIPT',
          quantity: recv.receivedQty,
          price: Number(line.price),
          documentType: 'PurchaseOrder',
          documentId: id,
          createdBy: userId,
        }, tx);

        await tx.purchaseOrderLine.update({
          where: { id: recv.lineId },
          data: { receivedQty: { increment: recv.receivedQty } },
        });
      }

      // Charge supplier account
      await this.settlements.createTransaction(orgId, {
        counterpartyId: po.supplierId,
        type: 'CHARGE',
        amount: Number(po.totalAmount),
        documentType: 'PurchaseOrder',
        documentId: id,
        createdBy: userId,
      }, tx);
    });

    // Determine new status
    const updatedLines = await this.prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: id } });
    const allReceived = updatedLines.every(l => l.receivedQty >= l.quantity);
    const anyReceived = updatedLines.some(l => l.receivedQty > 0);
    const newStatus = allReceived ? 'RECEIVED' : anyReceived ? 'PARTIAL' : po.status;

    await this.prisma.purchaseOrder.update({ where: { id }, data: { status: newStatus } });
    return this.findOne(orgId, id);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const po = await this.prisma.purchaseOrder.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!po) throw new NotFoundException('Замовлення не знайдено');
    if (po.status !== 'DRAFT') throw new BadRequestException('Видалити можна лише чернетку');
    await this.prisma.purchaseOrder.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  private toDto(po: any): PurchaseOrderResponseDto {
    const sup = po.supplier;
    const supplierName = sup?.companyName ?? [sup?.lastName, sup?.firstName].filter(Boolean).join(' ') ?? undefined;
    return {
      id: po.id, orgId: po.orgId, number: po.number, status: po.status,
      supplierId: po.supplierId, supplierName,
      warehouseId: po.warehouseId, warehouseName: po.warehouse?.name,
      totalAmount: Number(po.totalAmount),
      notes: po.notes ?? null,
      lines: (po.lines ?? []).map((l: any) => ({
        id: l.id, goodId: l.goodId,
        goodName: l.good?.name, goodSku: l.good?.sku ?? null, unit: l.good?.unit,
        quantity: l.quantity, price: Number(l.price),
        amount: l.quantity * Number(l.price), receivedQty: l.receivedQty,
      })),
      createdAt: po.createdAt, updatedAt: po.updatedAt,
    };
  }
}
