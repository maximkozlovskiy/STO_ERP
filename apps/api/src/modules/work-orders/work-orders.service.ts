import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MaintenanceSchedulesService } from '../maintenance-schedules/maintenance-schedules.service';
import { RepairCategory, WorkOrderPriority, WorkOrderStatus } from '@prisma/client';
import { formatPersonName } from '@sto/shared';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PdfService } from '../pdf/pdf.service';
import { WORK_ORDER_TRANSITIONS, CLOSED_STATUSES, DELETABLE_STATUSES, RESERVATION_ACTIVE_STATUSES, EDITABLE_STATUSES } from './work-orders.fsm';
import {
  CreateWorkOrderDto, UpdateWorkOrderDto, WorkOrderQueryDto,
  WorkOrderResponseDto, WorkOrderDetailDto, PaginatedWorkOrdersDto,
  CreateWorkOrderLineDto, UpdateWorkOrderLineDto, WorkOrderLineResponseDto,
  CreateWorkOrderPartDto, UpdateWorkOrderPartDto, WorkOrderPartResponseDto,
} from './work-orders.dto';

@Injectable()
export class WorkOrdersService {
  private readonly logger = new Logger(WorkOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly settlements: SettlementsService,
    private readonly notifications: NotificationsService,
    private readonly docNumbers: DocumentNumberService,
    private readonly maintenanceSchedules: MaintenanceSchedulesService,
    private readonly pdf: PdfService,
  ) {}

  // ─── CRUD ────────────────────────────────────────────────

  async findAll(orgId: string, query: WorkOrderQueryDto): Promise<PaginatedWorkOrdersDto> {
    const showDeleted = query.showDeleted === 'true';
    const where: Prisma.WorkOrderWhereInput = {
      orgId,
      ...(showDeleted ? {} : { deletedAt: null }),
    };
    if (query.status) where.status = query.status;
    if (query.priority) where.priority = query.priority;
    if (query.branchId) where.branchId = query.branchId;
    if (query.counterpartyId) where.counterpartyId = query.counterpartyId;
    if (query.vehicleId) where.vehicleId = query.vehicleId;
    if (query.repairCategory) where.repairCategory = query.repairCategory as RepairCategory;
    if (query.employeeId) {
      // F6: surface only orders that have at least one line assigned to this employee.
      // `some` produces a correlated EXISTS subquery and respects soft-deleted lines.
      where.lines = { some: { employeeId: query.employeeId, deletedAt: null } };
    }
    if (query.q) {
      where.OR = [
        { number: { contains: query.q, mode: 'insensitive' } },
        { counterparty: { companyName: { contains: query.q, mode: 'insensitive' } } },
        { counterparty: { lastName: { contains: query.q, mode: 'insensitive' } } },
        { counterparty: { firstName: { contains: query.q, mode: 'insensitive' } } },
      ];
    }

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

    return { items: items.map(item => this.toDto(item)), total, page: query.page, limit: query.limit };
  }

  async findOne(orgId: string, id: string): Promise<WorkOrderDetailDto> {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        vehicle: { select: { make: true, model: true, licensePlate: true } },
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        branch: { select: { name: true } },
        lines: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          include: {
            work: { select: { name: true } },
            employee: { select: { firstName: true, lastName: true } },
          },
        },
        parts: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          include: { good: { select: { name: true } } },
        },
      },
    });
    if (!wo) throw new NotFoundException('Наряд не знайдено');

    return {
      ...this.toDto(wo),
      lines: wo.lines.map(l => this.toLineDto(l)),
      parts: wo.parts.map(p => this.toPartDto(p)),
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

    const number = await this.docNumbers.next(orgId, 'WORK_ORDER');

    const wo = await this.prisma.workOrder.create({
      data: {
        orgId,
        branchId: dto.branchId,
        vehicleId: dto.vehicleId,
        counterpartyId: dto.counterpartyId,
        number,
        description: dto.description,
        inMileage: dto.inMileage,
        priority: dto.priority ?? 'NORMAL',
        repairCategory: dto.repairCategory ?? null,
        plannedAt: dto.plannedAt ? new Date(dto.plannedAt) : null,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
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
    if (CLOSED_STATUSES.includes(wo.status)) {
      throw new BadRequestException('Не можна редагувати закритий наряд');
    }

    const updated = await this.prisma.workOrder.update({
      where: { id, orgId },
      data: {
        description: dto.description,
        inMileage: dto.inMileage,
        outMileage: dto.outMileage,
        priority: dto.priority,
        repairCategory: dto.repairCategory,
        clientApproval: dto.clientApproval,
        // Distinguish "field omitted" (undefined → skip) from "field cleared"
        // (null → set NULL). `dto.plannedAt === null` writes NULL.
        plannedAt:
          dto.plannedAt === undefined ? undefined : dto.plannedAt === null ? null : new Date(dto.plannedAt),
        dueDate:
          dto.dueDate === undefined ? undefined : dto.dueDate === null ? null : new Date(dto.dueDate),
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
    if (!DELETABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException('Можна видалити лише наряд у статусі Чернетка або Скасовано');
    }
    await this.prisma.workOrder.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
  }

  // ─── FSM ─────────────────────────────────────────────────

  async transition(orgId: string, id: string, newStatus: WorkOrderStatus, userId?: string): Promise<WorkOrderResponseDto> {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { parts: { where: { deletedAt: null }, take: 1000 } },
    });
    if (!wo) throw new NotFoundException('Наряд не знайдено');

    const allowed = WORK_ORDER_TRANSITIONS[wo.status];
    if (!allowed.includes(newStatus)) {
      throw new BadRequestException(`Перехід зі статусу "${wo.status}" в "${newStatus}" неможливий`);
    }

    const updates: { status: WorkOrderStatus; completedAt?: Date } = { status: newStatus };
    if (newStatus === 'COMPLETED') updates.completedAt = new Date();

    // All side-effects + status update run in one transaction to prevent partial state
    const updated = await this.prisma.$transaction(async (tx) => {
      if (newStatus === 'IN_PROGRESS') {
        await this.reserveParts(orgId, id, userId, tx);
      }

      if (newStatus === 'COMPLETED') {
        await this.writeOffPartsAndCharge(orgId, wo, userId, tx);
      }

      if (newStatus === 'CANCELLED' && RESERVATION_ACTIVE_STATUSES.includes(wo.status)) {
        await this.releasePartReservations(orgId, id, userId, tx);
      }

      return tx.workOrder.update({
        where: { id, orgId },
        data: updates,
        include: {
          vehicle: { select: { make: true, model: true, licensePlate: true } },
          counterparty: { select: { firstName: true, lastName: true, companyName: true, phone: true } },
          branch: { select: { name: true } },
        },
      });
    });

    // Sync Vehicle.currentMileage from outMileage when WO completes.
    // Bug #75: Prisma `lt` filter EXCLUDES NULL rows — vehicles created without
    // an initial mileage stay NULL forever. Match both "lower" and "NULL".
    if (newStatus === 'COMPLETED' && wo.outMileage) {
      this.prisma.vehicle.updateMany({
        where: {
          id: wo.vehicleId, orgId,
          OR: [
            { currentMileage: null },
            { currentMileage: { lt: wo.outMileage } },
          ],
        },
        data: { currentMileage: wo.outMileage },
      }).catch((e: unknown) => this.logger.warn(`Помилка оновлення пробігу авто: ${e instanceof Error ? e.message : e}`));
    }

    // Auto-update maintenance schedules when MAINTENANCE WO completes
    if (newStatus === 'COMPLETED' && wo.repairCategory === RepairCategory.MAINTENANCE) {
      this.maintenanceSchedules.updateAfterWorkOrder(
        orgId, wo.vehicleId, updates.completedAt!, wo.outMileage ?? undefined,
      ).catch((e: unknown) => this.logger.warn(`Помилка оновлення ТО: ${e instanceof Error ? e.message : e}`));
    }

    // Send notifications (fire-and-forget via BullMQ queue — offline safe)
    if (newStatus === 'COMPLETED') {
      this.notifications.send(orgId, 'WO_COMPLETED', {
        branchId: updated.branchId,
        phone: updated.counterparty.phone,
        workOrderNumber: updated.number,
        clientName: formatPersonName(updated.counterparty.lastName, updated.counterparty.firstName, updated.counterparty.companyName),
      }).catch((e: unknown) => this.logger.warn(`Помилка сповіщення WO_COMPLETED: ${e instanceof Error ? e.message : e}`));
    }

    return this.toDto(updated);
  }

  private async reserveParts(orgId: string, workOrderId: string, userId?: string, tx?: Prisma.TransactionClient): Promise<void> {
    const db = tx ?? this.prisma;
    const parts = await db.workOrderPart.findMany({ where: { workOrderId, orgId, deletedAt: null }, take: 1000 });
    for (const part of parts) {
      await this.inventory.createMovement(orgId, {
        goodId: part.goodId,
        warehouseId: part.warehouseId,
        type: 'RESERVATION',
        quantity: part.quantity,
        documentType: 'WorkOrder',
        documentId: workOrderId,
        createdBy: userId,
      }, db);
    }
  }

  private async releasePartReservations(orgId: string, workOrderId: string, userId?: string, tx?: Prisma.TransactionClient): Promise<void> {
    const db = tx ?? this.prisma;
    const parts = await db.workOrderPart.findMany({ where: { workOrderId, orgId, deletedAt: null }, take: 1000 });
    for (const part of parts) {
      await this.inventory.createMovement(orgId, {
        goodId: part.goodId,
        warehouseId: part.warehouseId,
        type: 'RESERVATION_RELEASE',
        quantity: -part.quantity,
        documentType: 'WorkOrder',
        documentId: workOrderId,
        createdBy: userId,
      }, db);
    }
  }

  private async writeOffPartsAndCharge(orgId: string, wo: { id: string; counterpartyId: string; totalAmount: Prisma.Decimal | null }, userId?: string, tx?: Prisma.TransactionClient): Promise<void> {
    const db = tx ?? this.prisma;
    const parts = await db.workOrderPart.findMany({ where: { workOrderId: wo.id, orgId, deletedAt: null }, take: 1000 });
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
      }, db);
      // Release the reservation that was created on IN_PROGRESS
      await this.inventory.createMovement(orgId, {
        goodId: part.goodId,
        warehouseId: part.warehouseId,
        type: 'RESERVATION_RELEASE',
        quantity: -part.quantity,
        documentType: 'WorkOrder',
        documentId: wo.id,
        createdBy: userId,
      }, db);
    }
    const chargeAmount = Number(wo.totalAmount ?? 0);
    if (chargeAmount <= 0) throw new BadRequestException('Загальна сума наряду дорівнює нулю — завершення неможливе');
    await this.settlements.createTransaction(orgId, {
      counterpartyId: wo.counterpartyId,
      type: 'CHARGE',
      amount: chargeAmount,
      documentType: 'WorkOrder',
      documentId: wo.id,
      createdBy: userId,
    }, db);
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

    const line = await this.prisma.$transaction(async (tx) => {
      const created = await tx.workOrderLine.create({
        data: { orgId, workOrderId, workId: dto.workId, employeeId: dto.employeeId, liftId: dto.liftId ?? null, normoHours, actualHours: dto.actualHours ?? null, price, amount, notes: dto.notes },
        include: { work: { select: { name: true } }, employee: { select: { firstName: true, lastName: true } } },
      });
      await this.recalcTotals(workOrderId, tx, orgId);
      return created;
    });

    return this.toLineDto(line);
  }

  async updateLine(orgId: string, workOrderId: string, lineId: string, dto: UpdateWorkOrderLineDto): Promise<WorkOrderLineResponseDto> {
    await this.getEditableWorkOrder(orgId, workOrderId);
    const line = await this.prisma.workOrderLine.findFirst({ where: { id: lineId, workOrderId, orgId, deletedAt: null } });
    if (!line) throw new NotFoundException('Позицію не знайдено');

    const normoHours = dto.normoHours ?? line.normoHours;
    const price = dto.price !== undefined ? dto.price : Number(line.price);
    const amount = normoHours * price;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.workOrderLine.update({
        where: { id: lineId, orgId },
        data: { normoHours, price, amount, liftId: dto.liftId, notes: dto.notes, ...(dto.actualHours !== undefined && { actualHours: dto.actualHours }) },
        include: { work: { select: { name: true } }, employee: { select: { firstName: true, lastName: true } } },
      });
      await this.recalcTotals(workOrderId, tx, orgId);
      return result;
    });

    return this.toLineDto(updated);
  }

  async removeLine(orgId: string, workOrderId: string, lineId: string): Promise<void> {
    await this.getEditableWorkOrder(orgId, workOrderId);
    const line = await this.prisma.workOrderLine.findFirst({ where: { id: lineId, workOrderId, orgId, deletedAt: null } });
    if (!line) throw new NotFoundException('Позицію не знайдено');
    await this.prisma.$transaction(async (tx) => {
      await tx.workOrderLine.update({ where: { id: lineId, orgId }, data: { deletedAt: new Date() } });
      await this.recalcTotals(workOrderId, tx, orgId);
    });
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

    const part = await this.prisma.$transaction(async (tx) => {
      const created = await tx.workOrderPart.create({
        data: { orgId, workOrderId, goodId: dto.goodId, warehouseId: dto.warehouseId, quantity: dto.quantity, price, amount },
        include: { good: { select: { name: true } } },
      });
      await this.recalcTotals(workOrderId, tx, orgId);
      return created;
    });

    return this.toPartDto(part);
  }

  async updatePart(orgId: string, workOrderId: string, partId: string, dto: UpdateWorkOrderPartDto): Promise<WorkOrderPartResponseDto> {
    await this.getEditableWorkOrder(orgId, workOrderId);
    const part = await this.prisma.workOrderPart.findFirst({ where: { id: partId, workOrderId, orgId, deletedAt: null } });
    if (!part) throw new NotFoundException('Позицію не знайдено');

    const quantity = dto.quantity ?? part.quantity;
    const price = dto.price !== undefined ? dto.price : Number(part.price);
    const amount = quantity * price;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.workOrderPart.update({
        where: { id: partId, orgId },
        data: { quantity, price, amount },
        include: { good: { select: { name: true } } },
      });
      await this.recalcTotals(workOrderId, tx, orgId);
      return result;
    });

    return this.toPartDto(updated);
  }

  async removePart(orgId: string, workOrderId: string, partId: string): Promise<void> {
    await this.getEditableWorkOrder(orgId, workOrderId);
    const part = await this.prisma.workOrderPart.findFirst({ where: { id: partId, workOrderId, orgId, deletedAt: null } });
    if (!part) throw new NotFoundException('Позицію не знайдено');
    await this.prisma.$transaction(async (tx) => {
      await tx.workOrderPart.update({ where: { id: partId, orgId }, data: { deletedAt: new Date() } });
      await this.recalcTotals(workOrderId, tx, orgId);
    });
  }

  // ─── Helpers ─────────────────────────────────────────────

  private async getEditableWorkOrder(orgId: string, workOrderId: string) {
    const wo = await this.prisma.workOrder.findFirst({ where: { id: workOrderId, orgId, deletedAt: null } });
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (!EDITABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException('Не можна редагувати позиції наряду в поточному статусі');
    }
    return wo;
  }

  private async recalcTotals(workOrderId: string, tx: Prisma.TransactionClient, orgId: string): Promise<void> {
    const [lines, parts] = await Promise.all([
      tx.workOrderLine.findMany({ where: { workOrderId, orgId, deletedAt: null }, select: { amount: true }, take: 1000 }),
      tx.workOrderPart.findMany({ where: { workOrderId, orgId, deletedAt: null }, select: { amount: true }, take: 1000 }),
    ]);
    const totalLabor = lines.reduce((s: number, l: { amount: Prisma.Decimal }) => s + Number(l.amount), 0);
    const totalParts = parts.reduce((s: number, p: { amount: Prisma.Decimal }) => s + Number(p.amount), 0);
    await tx.workOrder.update({
      where: { id: workOrderId, orgId },
      data: { totalLabor, totalParts, totalAmount: totalLabor + totalParts },
    });
  }

  // ─── Mappers ─────────────────────────────────────────────

  async generatePdf(orgId: string, id: string): Promise<Buffer> {
    const [wo, org] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id, orgId, deletedAt: null },
        include: {
          vehicle: { select: { make: true, model: true, licensePlate: true } },
          counterparty: { select: { firstName: true, lastName: true, companyName: true, phone: true } },
          lines: {
            where: { deletedAt: null },
            include: { work: { select: { name: true } } },
            take: 500,
          },
          parts: {
            where: { deletedAt: null },
            include: { good: { select: { name: true } } },
            take: 500,
          },
        },
      }),
      this.prisma.organisation.findFirst({ where: { id: orgId }, select: { name: true, edrpou: true } }),
    ]);
    if (!wo) throw new NotFoundException('Наряд не знайдено');

    const cp = wo.counterparty;
    const counterpartyName = formatPersonName(cp?.lastName, cp?.firstName, cp?.companyName) || '';
    const vehicleLabel = wo.vehicle
      ? `${wo.vehicle.make} ${wo.vehicle.model}${wo.vehicle.licensePlate ? ` (${wo.vehicle.licensePlate})` : ''}`
      : '';

    return this.pdf.generateWorkOrderPdf({
      org: { name: org?.name ?? '', edrpou: org?.edrpou },
      counterparty: { name: counterpartyName, phone: cp?.phone },
      vehicleLabel,
      number: wo.number,
      date: wo.createdAt,
      works: wo.lines.map((l) => ({
        name: l.work?.name ?? '',
        quantity: l.actualHours ?? l.normoHours,
        price: Number(l.price),
        total: Number(l.amount),
      })),
      parts: wo.parts.map((p) => ({
        name: p.good?.name ?? '',
        quantity: p.quantity,
        price: Number(p.price),
        total: Number(p.amount),
      })),
      total: Number(wo.totalAmount),
    });
  }

  private toDto(wo: {
    id: string; orgId: string; number: string; status: WorkOrderStatus;
    priority: WorkOrderPriority; repairCategory: RepairCategory | null;
    branchId: string; vehicleId: string; counterpartyId: string;
    description: string | null; inMileage: number | null; outMileage: number | null;
    plannedAt: Date | null; dueDate: Date | null; completedAt: Date | null; clientApproval: boolean;
    totalLabor: Prisma.Decimal; totalParts: Prisma.Decimal; totalAmount: Prisma.Decimal; paidAmount: Prisma.Decimal | null;
    createdAt: Date; updatedAt: Date;
    branch?: { name: string } | null;
    vehicle?: { make: string; model: string; licensePlate: string | null } | null;
    counterparty?: { firstName: string | null; lastName: string | null; companyName: string | null } | null;
  }): WorkOrderResponseDto {
    const cp = wo.counterparty;
    const cpName = formatPersonName(cp?.lastName, cp?.firstName, cp?.companyName) || undefined;
    return {
      id: wo.id, orgId: wo.orgId, number: wo.number, status: wo.status,
      priority: wo.priority, repairCategory: wo.repairCategory ?? null,
      branchId: wo.branchId, branchName: wo.branch?.name,
      vehicleId: wo.vehicleId,
      vehicleSummary: wo.vehicle ? `${wo.vehicle.make} ${wo.vehicle.model}${wo.vehicle.licensePlate ? ` (${wo.vehicle.licensePlate})` : ''}` : undefined,
      counterpartyId: wo.counterpartyId, counterpartyName: cpName,
      description: wo.description ?? null,
      inMileage: wo.inMileage ?? null, outMileage: wo.outMileage ?? null,
      plannedAt: wo.plannedAt ?? null, dueDate: wo.dueDate ?? null, completedAt: wo.completedAt ?? null,
      clientApproval: wo.clientApproval,
      totalLabor: Number(wo.totalLabor), totalParts: Number(wo.totalParts),
      totalAmount: Number(wo.totalAmount), paidAmount: wo.paidAmount != null ? Number(wo.paidAmount) : 0,
      createdAt: wo.createdAt, updatedAt: wo.updatedAt,
    };
  }

  private toLineDto(line: {
    id: string; workOrderId: string; workId: string; employeeId: string; liftId: string | null;
    normoHours: number; actualHours: number | null; price: Prisma.Decimal; amount: Prisma.Decimal; notes: string | null; createdAt: Date;
    work?: { name: string } | null;
    employee?: { firstName: string; lastName: string } | null;
  }): WorkOrderLineResponseDto {
    return {
      id: line.id, workOrderId: line.workOrderId,
      workId: line.workId, workName: line.work?.name,
      employeeId: line.employeeId,
      employeeName: line.employee ? `${line.employee.lastName} ${line.employee.firstName}` : undefined,
      liftId: line.liftId ?? null,
      normoHours: line.normoHours, actualHours: line.actualHours ?? null,
      price: Number(line.price), amount: Number(line.amount),
      notes: line.notes ?? null, createdAt: line.createdAt,
    };
  }

  private toPartDto(part: {
    id: string; workOrderId: string; goodId: string; warehouseId: string;
    quantity: number; price: Prisma.Decimal; amount: Prisma.Decimal; createdAt: Date;
    good?: { name: string } | null;
  }): WorkOrderPartResponseDto {
    return {
      id: part.id, workOrderId: part.workOrderId,
      goodId: part.goodId, goodName: part.good?.name,
      warehouseId: part.warehouseId,
      quantity: part.quantity, price: Number(part.price), amount: Number(part.amount),
      createdAt: part.createdAt,
    };
  }
}
