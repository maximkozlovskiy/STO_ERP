import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WorkOrderStatus } from '@prisma/client';
import { WORK_ORDER_TRANSITIONS } from './work-orders.fsm';
import {
  CreateWorkOrderDto, UpdateWorkOrderDto, WorkOrderQueryDto,
  WorkOrderResponseDto, WorkOrderDetailDto, PaginatedWorkOrdersDto,
  CreateWorkOrderLineDto, UpdateWorkOrderLineDto, WorkOrderLineResponseDto,
  CreateWorkOrderPartDto, UpdateWorkOrderPartDto, WorkOrderPartResponseDto,
} from './work-orders.dto';

@Injectable()
export class WorkOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly settlements: SettlementsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ─── CRUD ────────────────────────────────────────────────

  async findAll(orgId: string, query: WorkOrderQueryDto): Promise<PaginatedWorkOrdersDto> {
    const where: any = { orgId, deletedAt: null };
    if (query.status) where.status = query.status;
    if (query.branchId) where.branchId = query.branchId;
    if (query.counterpartyId) where.counterpartyId = query.counterpartyId;
    if (query.vehicleId) where.vehicleId = query.vehicleId;

    const skip = (query.page - 1) * query.limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.workOrder.findMany({
        where, skip, take: query.limit,
        orderBy: { createdAt: 'desc' },
        include: {
          vehicle: { select: { make: true, model: true, licensePlate: true } },
          counterparty: { select: { firstName: true, lastName: true, companyName: true } },
          branch: { select: { name: true } },
        },
      }),
      this.prisma.workOrder.count({ where }),
    ]);

    return { items: items.map(this.toDto), total, page: query.page, limit: query.limit };
  }

  async findOne(orgId: string, id: string): Promise<WorkOrderDetailDto> {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        vehicle: { select: { make: true, model: true, licensePlate: true } },
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        branch: { select: { name: true } },
        lines: {
          orderBy: { createdAt: 'asc' },
          include: {
            work: { select: { name: true } },
            employee: { select: { firstName: true, lastName: true } },
          },
        },
        parts: {
          orderBy: { createdAt: 'asc' },
          include: { good: { select: { name: true } } },
        },
      },
    });
    if (!wo) throw new NotFoundException('Наряд не знайдено');

    return {
      ...this.toDto(wo),
      lines: wo.lines.map(this.toLineDto),
      parts: wo.parts.map(this.toPartDto),
    };
  }

  async create(orgId: string, dto: CreateWorkOrderDto): Promise<WorkOrderResponseDto> {
    const [branch, vehicle, counterparty] = await Promise.all([
      this.prisma.garageBranch.findFirst({ where: { id: dto.branchId, orgId, deletedAt: null } }),
      this.prisma.vehicle.findFirst({ where: { id: dto.vehicleId, orgId, deletedAt: null } }),
      this.prisma.counterparty.findFirst({ where: { id: dto.counterpartyId, orgId, deletedAt: null } }),
    ]);
    if (!branch) throw new NotFoundException('Філію не знайдено');
    if (!vehicle) throw new NotFoundException('Автомобіль не знайдено');
    if (!counterparty) throw new NotFoundException('Контрагента не знайдено');

    const count = await this.prisma.workOrder.count({ where: { orgId } });
    const number = `WO-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;

    const wo = await this.prisma.workOrder.create({
      data: {
        orgId,
        branchId: dto.branchId,
        vehicleId: dto.vehicleId,
        counterpartyId: dto.counterpartyId,
        number,
        description: dto.description,
        inMileage: dto.inMileage,
        plannedAt: dto.plannedAt ? new Date(dto.plannedAt) : null,
      },
      include: {
        vehicle: { select: { make: true, model: true, licensePlate: true } },
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        branch: { select: { name: true } },
      },
    });

    return this.toDto(wo);
  }

  async update(orgId: string, id: string, dto: UpdateWorkOrderDto): Promise<WorkOrderResponseDto> {
    const wo = await this.prisma.workOrder.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (['COMPLETED', 'INVOICED', 'PAID', 'ARCHIVED', 'CANCELLED'].includes(wo.status)) {
      throw new BadRequestException('Не можна редагувати закритий наряд');
    }

    const updated = await this.prisma.workOrder.update({
      where: { id },
      data: {
        description: dto.description,
        inMileage: dto.inMileage,
        outMileage: dto.outMileage,
        plannedAt: dto.plannedAt ? new Date(dto.plannedAt) : undefined,
      },
      include: {
        vehicle: { select: { make: true, model: true, licensePlate: true } },
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        branch: { select: { name: true } },
      },
    });

    return this.toDto(updated);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const wo = await this.prisma.workOrder.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (!['DRAFT', 'CANCELLED'].includes(wo.status)) {
      throw new BadRequestException('Можна видалити лише наряд у статусі Чернетка або Скасовано');
    }
    await this.prisma.workOrder.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  // ─── FSM ─────────────────────────────────────────────────

  async transition(orgId: string, id: string, newStatus: WorkOrderStatus, userId?: string): Promise<WorkOrderResponseDto> {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { parts: true },
    });
    if (!wo) throw new NotFoundException('Наряд не знайдено');

    const allowed = WORK_ORDER_TRANSITIONS[wo.status];
    if (!allowed.includes(newStatus)) {
      throw new BadRequestException(`Перехід зі статусу "${wo.status}" в "${newStatus}" неможливий`);
    }

    const updates: any = { status: newStatus };
    if (newStatus === 'COMPLETED') updates.completedAt = new Date();

    if (newStatus === 'IN_PROGRESS') {
      await this.reserveParts(orgId, id, userId);
    }

    if (newStatus === 'COMPLETED') {
      await this.writeOffPartsAndCharge(orgId, wo, userId);
    }

    if (newStatus === 'CANCELLED' && wo.status === 'IN_PROGRESS') {
      await this.releasePartReservations(orgId, id, userId);
    }

    const updated = await this.prisma.workOrder.update({
      where: { id },
      data: updates,
      include: {
        vehicle: { select: { make: true, model: true, licensePlate: true } },
        counterparty: { select: { firstName: true, lastName: true, companyName: true, phone: true } },
        branch: { select: { name: true } },
      },
    });

    // Send notifications (fire-and-forget via BullMQ queue — offline safe)
    if (newStatus === 'COMPLETED') {
      this.notifications.send(orgId, 'WO_COMPLETED', {
        branchId: updated.branchId,
        phone: updated.counterparty.phone,
        workOrderNumber: updated.number,
        clientName: updated.counterparty.companyName ??
          [updated.counterparty.lastName, updated.counterparty.firstName].filter(Boolean).join(' '),
      }).catch(() => {/* non-critical */});
    }

    return this.toDto(updated);
  }

  private async reserveParts(orgId: string, workOrderId: string, userId?: string): Promise<void> {
    const parts = await this.prisma.workOrderPart.findMany({ where: { workOrderId } });
    for (const part of parts) {
      await this.inventory.createMovement(orgId, {
        goodId: part.goodId,
        warehouseId: part.warehouseId,
        type: 'RESERVATION',
        quantity: part.quantity,
        documentType: 'WorkOrder',
        documentId: workOrderId,
        createdBy: userId,
      });
    }
  }

  private async releasePartReservations(orgId: string, workOrderId: string, userId?: string): Promise<void> {
    const parts = await this.prisma.workOrderPart.findMany({ where: { workOrderId } });
    for (const part of parts) {
      await this.inventory.createMovement(orgId, {
        goodId: part.goodId,
        warehouseId: part.warehouseId,
        type: 'RESERVATION_RELEASE',
        quantity: -part.quantity,
        documentType: 'WorkOrder',
        documentId: workOrderId,
        createdBy: userId,
      });
    }
  }

  private async writeOffPartsAndCharge(orgId: string, wo: any, userId?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const parts = await tx.workOrderPart.findMany({ where: { workOrderId: wo.id } });
      for (const part of parts) {
        await this.inventory.createMovement(orgId, {
          goodId: part.goodId,
          warehouseId: part.warehouseId,
          type: 'WRITEOFF',
          quantity: -part.quantity,
          price: Number(part.price),
          documentType: 'WorkOrder',
          documentId: wo.id,
          createdBy: userId,
        }, tx);
        // Release the reservation that was created on IN_PROGRESS
        await this.inventory.createMovement(orgId, {
          goodId: part.goodId,
          warehouseId: part.warehouseId,
          type: 'RESERVATION_RELEASE',
          quantity: -part.quantity,
          documentType: 'WorkOrder',
          documentId: wo.id,
          createdBy: userId,
        }, tx);
      }
      await this.settlements.createTransaction(orgId, {
        counterpartyId: wo.counterpartyId,
        type: 'CHARGE',
        amount: Number(wo.totalAmount),
        documentType: 'WorkOrder',
        documentId: wo.id,
        createdBy: userId,
      }, tx);
    });
  }

  // ─── Lines ───────────────────────────────────────────────

  async addLine(orgId: string, workOrderId: string, dto: CreateWorkOrderLineDto): Promise<WorkOrderLineResponseDto> {
    await this.getEditableWorkOrder(orgId, workOrderId);

    const work = await this.prisma.work.findFirst({ where: { id: dto.workId, orgId, deletedAt: null } });
    if (!work) throw new NotFoundException('Роботу не знайдено');

    const employee = await this.prisma.employee.findFirst({ where: { id: dto.employeeId, orgId, deletedAt: null } });
    if (!employee) throw new NotFoundException('Співробітника не знайдено');

    const normoHours = dto.normoHours ?? work.normoHours;
    const price = dto.price !== undefined ? dto.price : Number(work.price);
    const amount = normoHours * price;

    const line = await this.prisma.workOrderLine.create({
      data: {
        orgId,
        workOrderId,
        workId: dto.workId,
        employeeId: dto.employeeId,
        liftId: dto.liftId ?? null,
        normoHours,
        price,
        amount,
        notes: dto.notes,
      },
      include: {
        work: { select: { name: true } },
        employee: { select: { firstName: true, lastName: true } },
      },
    });

    await this.recalcTotals(workOrderId);
    return this.toLineDto(line);
  }

  async updateLine(orgId: string, workOrderId: string, lineId: string, dto: UpdateWorkOrderLineDto): Promise<WorkOrderLineResponseDto> {
    await this.getEditableWorkOrder(orgId, workOrderId);
    const line = await this.prisma.workOrderLine.findFirst({ where: { id: lineId, workOrderId } });
    if (!line) throw new NotFoundException('Позицію не знайдено');

    const normoHours = dto.normoHours ?? line.normoHours;
    const price = dto.price !== undefined ? dto.price : Number(line.price);
    const amount = normoHours * price;

    const updated = await this.prisma.workOrderLine.update({
      where: { id: lineId },
      data: { normoHours, price, amount, liftId: dto.liftId, notes: dto.notes },
      include: {
        work: { select: { name: true } },
        employee: { select: { firstName: true, lastName: true } },
      },
    });

    await this.recalcTotals(workOrderId);
    return this.toLineDto(updated);
  }

  async removeLine(orgId: string, workOrderId: string, lineId: string): Promise<void> {
    await this.getEditableWorkOrder(orgId, workOrderId);
    const line = await this.prisma.workOrderLine.findFirst({ where: { id: lineId, workOrderId } });
    if (!line) throw new NotFoundException('Позицію не знайдено');
    await this.prisma.workOrderLine.delete({ where: { id: lineId } });
    await this.recalcTotals(workOrderId);
  }

  // ─── Parts ───────────────────────────────────────────────

  async addPart(orgId: string, workOrderId: string, dto: CreateWorkOrderPartDto): Promise<WorkOrderPartResponseDto> {
    await this.getEditableWorkOrder(orgId, workOrderId);

    const good = await this.prisma.good.findFirst({ where: { id: dto.goodId, orgId, deletedAt: null } });
    if (!good) throw new NotFoundException('Товар не знайдено');

    const warehouse = await this.prisma.warehouse.findFirst({ where: { id: dto.warehouseId, orgId, deletedAt: null } });
    if (!warehouse) throw new NotFoundException('Склад не знайдено');

    const price = dto.price !== undefined ? dto.price : Number(good.salePrice);
    const amount = dto.quantity * price;

    const part = await this.prisma.workOrderPart.create({
      data: {
        orgId,
        workOrderId,
        goodId: dto.goodId,
        warehouseId: dto.warehouseId,
        quantity: dto.quantity,
        price,
        amount,
      },
      include: { good: { select: { name: true } } },
    });

    await this.recalcTotals(workOrderId);
    return this.toPartDto(part);
  }

  async updatePart(orgId: string, workOrderId: string, partId: string, dto: UpdateWorkOrderPartDto): Promise<WorkOrderPartResponseDto> {
    await this.getEditableWorkOrder(orgId, workOrderId);
    const part = await this.prisma.workOrderPart.findFirst({ where: { id: partId, workOrderId } });
    if (!part) throw new NotFoundException('Позицію не знайдено');

    const quantity = dto.quantity ?? part.quantity;
    const price = dto.price !== undefined ? dto.price : Number(part.price);
    const amount = quantity * price;

    const updated = await this.prisma.workOrderPart.update({
      where: { id: partId },
      data: { quantity, price, amount },
      include: { good: { select: { name: true } } },
    });

    await this.recalcTotals(workOrderId);
    return this.toPartDto(updated);
  }

  async removePart(orgId: string, workOrderId: string, partId: string): Promise<void> {
    await this.getEditableWorkOrder(orgId, workOrderId);
    const part = await this.prisma.workOrderPart.findFirst({ where: { id: partId, workOrderId } });
    if (!part) throw new NotFoundException('Позицію не знайдено');
    await this.prisma.workOrderPart.delete({ where: { id: partId } });
    await this.recalcTotals(workOrderId);
  }

  // ─── Helpers ─────────────────────────────────────────────

  private async getEditableWorkOrder(orgId: string, workOrderId: string) {
    const wo = await this.prisma.workOrder.findFirst({ where: { id: workOrderId, orgId, deletedAt: null } });
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    const editableStatuses: WorkOrderStatus[] = ['DRAFT', 'ESTIMATE', 'APPROVED'];
    if (!editableStatuses.includes(wo.status)) {
      throw new BadRequestException('Не можна редагувати позиції наряду в поточному статусі');
    }
    return wo;
  }

  private async recalcTotals(workOrderId: string): Promise<void> {
    const [lines, parts] = await Promise.all([
      this.prisma.workOrderLine.findMany({ where: { workOrderId }, select: { amount: true } }),
      this.prisma.workOrderPart.findMany({ where: { workOrderId }, select: { amount: true } }),
    ]);
    const totalLabor = lines.reduce((s, l) => s + Number(l.amount), 0);
    const totalParts = parts.reduce((s, p) => s + Number(p.amount), 0);
    await this.prisma.workOrder.update({
      where: { id: workOrderId },
      data: { totalLabor, totalParts, totalAmount: totalLabor + totalParts },
    });
  }

  // ─── Mappers ─────────────────────────────────────────────

  private toDto(wo: any): WorkOrderResponseDto {
    const cp = wo.counterparty;
    const cpName = cp?.companyName ?? [cp?.lastName, cp?.firstName].filter(Boolean).join(' ') ?? undefined;
    return {
      id: wo.id, orgId: wo.orgId, number: wo.number, status: wo.status,
      branchId: wo.branchId, branchName: wo.branch?.name,
      vehicleId: wo.vehicleId,
      vehicleSummary: wo.vehicle ? `${wo.vehicle.make} ${wo.vehicle.model}${wo.vehicle.licensePlate ? ` (${wo.vehicle.licensePlate})` : ''}` : undefined,
      counterpartyId: wo.counterpartyId, counterpartyName: cpName,
      description: wo.description ?? null,
      inMileage: wo.inMileage ?? null, outMileage: wo.outMileage ?? null,
      plannedAt: wo.plannedAt ?? null, completedAt: wo.completedAt ?? null,
      totalLabor: Number(wo.totalLabor), totalParts: Number(wo.totalParts),
      totalAmount: Number(wo.totalAmount), paidAmount: Number(wo.paidAmount),
      createdAt: wo.createdAt, updatedAt: wo.updatedAt,
    };
  }

  private toLineDto(line: any): WorkOrderLineResponseDto {
    return {
      id: line.id, workOrderId: line.workOrderId,
      workId: line.workId, workName: line.work?.name,
      employeeId: line.employeeId,
      employeeName: line.employee ? `${line.employee.lastName} ${line.employee.firstName}` : undefined,
      liftId: line.liftId ?? null,
      normoHours: line.normoHours, price: Number(line.price), amount: Number(line.amount),
      notes: line.notes ?? null, createdAt: line.createdAt,
    };
  }

  private toPartDto(part: any): WorkOrderPartResponseDto {
    return {
      id: part.id, workOrderId: part.workOrderId,
      goodId: part.goodId, goodName: part.good?.name,
      warehouseId: part.warehouseId,
      quantity: part.quantity, price: Number(part.price), amount: Number(part.amount),
      createdAt: part.createdAt,
    };
  }
}
