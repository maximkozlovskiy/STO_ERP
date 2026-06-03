import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MaintenanceSchedulesService } from '../maintenance-schedules/maintenance-schedules.service';
import { RepairCategory, WorkOrderPriority, WorkOrderStatus } from '@prisma/client';
import { formatPersonName, TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PdfService } from '../pdf/pdf.service';
import {
  WORK_ORDER_TRANSITIONS,
  CLOSED_STATUSES,
  DELETABLE_STATUSES,
  RESERVATION_ACTIVE_STATUSES,
  EDITABLE_STATUSES,
} from './work-orders.fsm';
import { AuditService } from '../audit/audit.service';
import { WarrantiesService } from '../warranties/warranties.service';
import { SettingsService } from '../settings/settings.service';
import {
  CreateWorkOrderDto,
  UpdateWorkOrderDto,
  WorkOrderQueryDto,
  WorkOrderResponseDto,
  WorkOrderDetailDto,
  PaginatedWorkOrdersDto,
  CreateWorkOrderLineDto,
  UpdateWorkOrderLineDto,
  WorkOrderLineResponseDto,
  CreateWorkOrderPartDto,
  UpdateWorkOrderPartDto,
  WorkOrderPartResponseDto,
} from './work-orders.dto';

/**
 * Bug #316: defense-in-depth для coefficient як дільника.
 * DTO `@Min(0.000001)` блокує coefficient=0 на write-path, але legacy/seed/CSV-import дані
 * можуть мати 0. `?? 1` НЕ ловить 0 (nullish coalescing спрацьовує лише на null/undefined).
 * `safeCoeff` повертає 1 для null/undefined/0/NaN/негативних значень — безпечно для `qty / coeff`.
 */
function safeCoeff(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 1;
  return value;
}

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
    private readonly audit: AuditService,
    private readonly warranties: WarrantiesService,
    private readonly settingsService: SettingsService,
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
        where,
        skip,
        take: query.limit,
        orderBy: { createdAt: 'desc' },
        include: {
          vehicle: { select: { make: true, model: true, licensePlate: true } },
          counterparty: { select: { firstName: true, lastName: true, companyName: true } },
          branch: { select: { name: true } },
          calendarSlots: {
            where: { deletedAt: null },
            orderBy: { startAt: 'asc' },
            select: {
              startAt: true,
              endAt: true,
              lift: { select: { name: true } },
            },
            take: 1,
          },
          _count: {
            select: {
              warranties: {
                where: { deletedAt: null, claimedAt: null, expiresAt: { gt: new Date() } },
              },
            },
          },
        },
      }),
      this.prisma.workOrder.count({ where }),
    ]);

    return {
      items: items.map(item => this.toDto(item)),
      total,
      page: query.page,
      limit: query.limit,
    };
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
          include: {
            good: {
              select: {
                name: true,
                unit: true,
                unitOfMeasure: { select: { shortName: true, coefficient: true } },
              },
            },
          },
        },
      },
    });
    if (!wo) throw new NotFoundException('Наряд не знайдено');

    // Batch-fetch GoodUoM coefficients for parts that have unitOfMeasureId set.
    const uomIds = wo.parts
      .map(p => (p as { unitOfMeasureId?: string | null }).unitOfMeasureId)
      .filter((id): id is string => !!id);
    const goodUoMMap: Record<
      string,
      { id: string; coefficient: number; unitOfMeasure: { shortName: string } }
    > = {};
    if (uomIds.length > 0) {
      const goodUoMs = await this.prisma.goodUoM.findMany({
        where: { id: { in: uomIds } },
        select: { id: true, coefficient: true, unitOfMeasure: { select: { shortName: true } } },
      });
      for (const u of goodUoMs) goodUoMMap[u.id] = u;
    }

    return {
      ...this.toDto(wo),
      lines: wo.lines.map(l => this.toLineDto(l)),
      parts: wo.parts.map(p => {
        const uomId = (p as { unitOfMeasureId?: string | null }).unitOfMeasureId;
        return this.toPartDto({
          ...p,
          unitOfMeasureId: uomId,
          goodUoM: uomId ? (goodUoMMap[uomId] ?? null) : null,
        });
      }),
    };
  }

  async create(
    orgId: string,
    dto: CreateWorkOrderDto,
    userId?: string,
  ): Promise<WorkOrderResponseDto> {
    const [branch, vehicle, counterparty] = await Promise.all([
      this.prisma.garageBranch.findFirst({ where: { id: dto.branchId, orgId, deletedAt: null } }),
      this.prisma.vehicle.findFirst({ where: { id: dto.vehicleId, orgId, deletedAt: null } }),
      this.prisma.counterparty.findFirst({
        where: { id: dto.counterpartyId, orgId, deletedAt: null },
      }),
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

    if (userId) {
      this.audit
        .record(orgId, 'WorkOrder', wo.id, 'CREATE', userId, undefined, {
          status: wo.status,
          number: wo.number,
        })
        .catch((e: unknown) =>
          this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : e}`),
        );
    }

    return this.toDto(wo);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateWorkOrderDto,
    userId?: string,
  ): Promise<WorkOrderResponseDto> {
    const wo = await this.prisma.workOrder.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (CLOSED_STATUSES.includes(wo.status)) {
      throw new BadRequestException('Не можна редагувати закритий наряд');
    }

    // Bug #86: capture old field-values BEFORE update so AuditEvent.diff is meaningful.
    // Only include fields user actually attempted to change (dto.X !== undefined).
    const oldData: Record<string, unknown> = {};
    const newData: Record<string, unknown> = {};
    const trackField = <K extends keyof UpdateWorkOrderDto>(key: K) => {
      if (dto[key] !== undefined) {
        oldData[key as string] = (wo as Record<string, unknown>)[key as string];
        newData[key as string] = dto[key];
      }
    };
    (
      [
        'description',
        'inMileage',
        'outMileage',
        'priority',
        'repairCategory',
        'clientApproval',
        'plannedAt',
        'dueDate',
      ] as const
    ).forEach(trackField);

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
          dto.plannedAt === undefined
            ? undefined
            : dto.plannedAt === null
              ? null
              : new Date(dto.plannedAt),
        dueDate:
          dto.dueDate === undefined
            ? undefined
            : dto.dueDate === null
              ? null
              : new Date(dto.dueDate),
      },
      include: {
        vehicle: { select: { make: true, model: true, licensePlate: true } },
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        branch: { select: { name: true } },
      },
    });

    // Bug #86: AuditEvent for field-level updates (only if something actually changed)
    if (userId && Object.keys(newData).length > 0) {
      this.audit
        .record(orgId, 'WorkOrder', id, 'UPDATE', userId, oldData, newData)
        .catch((e: unknown) =>
          this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : e}`),
        );
    }

    return this.toDto(updated);
  }

  async remove(orgId: string, id: string, userId?: string): Promise<void> {
    const wo = await this.prisma.workOrder.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (!DELETABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException('Можна видалити лише наряд у статусі Чернетка або Скасовано');
    }
    await this.prisma.workOrder.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
    if (userId) {
      this.audit
        .record(orgId, 'WorkOrder', id, 'DELETE', userId, { status: wo.status, number: wo.number })
        .catch((e: unknown) =>
          this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : e}`),
        );
    }
  }

  async clone(orgId: string, id: string, userId: string): Promise<WorkOrderResponseDto> {
    // 1. Find original WO with lines and parts.
    // Narrow select: clone-операція використовує лише FK scalars (vehicleId/counterpartyId/branchId)
    // + lines/parts scalars (workId/employeeId/liftId/goodId/warehouseId/price/normoHours/amount/notes).
    // Раніше include тягнув vehicle/counterparty/branch (повні labels) + lines.work.name + lines.employee.firstName/lastName
    // + parts.good.name/unit/unitOfMeasure — все це НЕ використовується у clone (лише ID-based create).
    const original = await this.prisma.workOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      select: {
        number: true,
        vehicleId: true,
        counterpartyId: true,
        branchId: true,
        description: true,
        inMileage: true,
        priority: true,
        repairCategory: true,
        dueDate: true,
        lines: {
          where: { deletedAt: null },
          select: {
            workId: true,
            employeeId: true,
            liftId: true,
            price: true,
            normoHours: true,
            notes: true,
            amount: true,
          },
        },
        parts: {
          where: { deletedAt: null },
          select: {
            goodId: true,
            quantity: true,
            price: true,
            warehouseId: true,
            amount: true,
          },
        },
      },
    });
    if (!original) throw new NotFoundException('Наряд не знайдено');

    // Bug #90: validate FK references still exist (not soft-deleted) BEFORE create.
    // Without this, FK violation surfaces as Prisma P2003 (HTTP 500) instead of a
    // friendly 404 with a clear message in Ukrainian.
    // Perf: docNumbers.next не залежить від FK validation — паралелимо разом.
    const [vehicle, counterparty, branch, number] = await Promise.all([
      this.prisma.vehicle.findFirst({
        where: { id: original.vehicleId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.counterparty.findFirst({
        where: { id: original.counterpartyId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.garageBranch.findFirst({
        where: { id: original.branchId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.docNumbers.next(orgId, 'WORK_ORDER'),
    ]);
    if (!vehicle) throw new NotFoundException('Автомобіль було видалено — клонування неможливе');
    if (!counterparty)
      throw new NotFoundException('Контрагента було видалено — клонування неможливе');
    if (!branch) throw new NotFoundException('Філію було видалено — клонування неможливе');

    // 3. Pre-compute totals from the original's lines/parts so the cloned WO
    // ships consistent totalLabor/totalParts/totalAmount (Bug #81). Without this,
    // Prisma defaults leave them at 0 while lines[].amount has real values.
    const totalLabor = original.lines.reduce((s, l) => s + Number(l.amount), 0);
    const totalParts = original.parts.reduce((s, p) => s + Number(p.amount), 0);

    // 4. Create cloned WO as DRAFT
    const cloned = await this.prisma.workOrder.create({
      data: {
        orgId,
        number,
        status: WorkOrderStatus.DRAFT,
        vehicleId: original.vehicleId,
        counterpartyId: original.counterpartyId,
        branchId: original.branchId,
        description: original.description,
        inMileage: original.inMileage,
        priority: original.priority,
        repairCategory: original.repairCategory,
        dueDate: original.dueDate,
        totalLabor,
        totalParts,
        totalAmount: totalLabor + totalParts,
        lines: {
          // Bug #94: clones are DRAFT — actualHours must reset to null. Copying the
          // original's value misleads "factual labour" reports for the new visit.
          create: original.lines.map(l => ({
            orgId,
            workId: l.workId,
            employeeId: l.employeeId,
            liftId: l.liftId ?? undefined,
            price: l.price,
            normoHours: l.normoHours,
            actualHours: null,
            notes: l.notes ?? null,
            amount: l.amount,
          })),
        },
        parts: {
          create: original.parts.map(p => ({
            orgId,
            goodId: p.goodId,
            quantity: p.quantity,
            price: p.price,
            warehouseId: p.warehouseId,
            amount: p.amount,
          })),
        },
      },
      include: {
        vehicle: { select: { make: true, model: true, licensePlate: true } },
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        branch: { select: { name: true } },
      },
    });

    // Bug #96: AuditEvent for clone — without this the "Журнал змін" tab of the
    // cloned WO is empty, hiding who/when created the duplicate.
    if (userId) {
      this.audit
        .record(orgId, 'WorkOrder', cloned.id, 'CREATE', userId, undefined, {
          status: cloned.status,
          number: cloned.number,
          clonedFromId: id,
          clonedFromNumber: original.number,
        })
        .catch((e: unknown) =>
          this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : e}`),
        );
    }

    return this.toDto(cloned);
  }

  // ─── FSM ─────────────────────────────────────────────────

  async transition(
    orgId: string,
    id: string,
    newStatus: WorkOrderStatus,
    userId?: string,
  ): Promise<WorkOrderResponseDto> {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { parts: { where: { deletedAt: null }, take: 1000 } },
    });
    if (!wo) throw new NotFoundException('Наряд не знайдено');

    const allowed = WORK_ORDER_TRANSITIONS[wo.status];
    if (!allowed.includes(newStatus)) {
      throw new BadRequestException(
        `Перехід зі статусу "${wo.status}" в "${newStatus}" неможливий`,
      );
    }

    const updates: { status: WorkOrderStatus; completedAt?: Date } = { status: newStatus };
    if (newStatus === 'COMPLETED') updates.completedAt = new Date();

    // All side-effects + status update run in one transaction to prevent partial state.
    // Bug #130: явний timeout 10s — COMPLETED транзакція робить N writeoff + N release + 1 charge
    // у циклі через workOrderPart; при 50+ запчастинах це може зайняти > 5s default.
    const updated = await this.prisma.$transaction(
      async tx => {
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
            counterparty: {
              select: { firstName: true, lastName: true, companyName: true, phone: true },
            },
            branch: { select: { name: true } },
          },
        });
      },
      { timeout: 10_000 },
    );

    // Sync Vehicle.currentMileage from outMileage when WO completes.
    // Bug #75: Prisma `lt` filter EXCLUDES NULL rows — vehicles created without
    // an initial mileage stay NULL forever. Match both "lower" and "NULL".
    if (newStatus === 'COMPLETED' && wo.outMileage) {
      this.prisma.vehicle
        .updateMany({
          where: {
            id: wo.vehicleId,
            orgId,
            OR: [{ currentMileage: null }, { currentMileage: { lt: wo.outMileage } }],
          },
          data: { currentMileage: wo.outMileage },
        })
        .catch((e: unknown) =>
          this.logger.warn(`Помилка оновлення пробігу авто: ${e instanceof Error ? e.message : e}`),
        );
    }

    // Auto-update maintenance schedules when MAINTENANCE WO completes
    if (newStatus === 'COMPLETED' && wo.repairCategory === RepairCategory.MAINTENANCE) {
      this.maintenanceSchedules
        .updateAfterWorkOrder(orgId, wo.vehicleId, updates.completedAt!, wo.outMileage ?? undefined)
        .catch((e: unknown) =>
          this.logger.warn(`Помилка оновлення ТО: ${e instanceof Error ? e.message : e}`),
        );
    }

    // Auto-create warranty after COMPLETED if warrantyDays > 0
    if (newStatus === 'COMPLETED') {
      this.settingsService
        .getOrganisationSettings(orgId)
        .then(settings => {
          const warrantyDays = settings.defaultWarrantyDays ?? 0;
          if (warrantyDays > 0) {
            return this.warranties.autoCreate(orgId, id, warrantyDays);
          }
        })
        .catch((e: unknown) =>
          this.logger.warn(`Warranty auto-create failed: ${e instanceof Error ? e.message : e}`),
        );
    }

    // Send notifications (fire-and-forget via BullMQ queue — offline safe)
    if (newStatus === 'COMPLETED') {
      this.notifications
        .send(orgId, 'WO_COMPLETED', {
          branchId: updated.branchId,
          phone: updated.counterparty.phone,
          workOrderNumber: updated.number,
          clientName: formatPersonName(
            updated.counterparty.lastName,
            updated.counterparty.firstName,
            updated.counterparty.companyName,
          ),
        })
        .catch((e: unknown) =>
          this.logger.warn(
            `Помилка сповіщення WO_COMPLETED: ${e instanceof Error ? e.message : e}`,
          ),
        );
    }

    // Audit log for status transition
    if (userId) {
      this.audit
        .record(
          orgId,
          'WorkOrder',
          id,
          'UPDATE',
          userId,
          { status: wo.status },
          { status: newStatus },
        )
        .catch((e: unknown) =>
          this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : e}`),
        );
    }

    return this.toDto(updated);
  }

  private async reserveParts(
    orgId: string,
    workOrderId: string,
    userId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    const parts = await db.workOrderPart.findMany({
      where: { workOrderId, orgId, deletedAt: null },
      take: 1000,
    });
    // Batch-fetch GoodUoM coefficients for qty conversion: qty_base = qty / coefficient
    const coeffMap = await this.fetchPartCoefficients(parts, db);

    for (const part of parts) {
      const coeff = coeffMap[part.id] ?? 1;
      await this.inventory.createMovement(
        orgId,
        {
          goodId: part.goodId,
          warehouseId: part.warehouseId,
          type: 'RESERVATION',
          quantity: part.quantity / coeff,
          documentType: 'WorkOrder',
          documentId: workOrderId,
          createdBy: userId,
        },
        db,
      );
    }
  }

  private async releasePartReservations(
    orgId: string,
    workOrderId: string,
    userId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    const parts = await db.workOrderPart.findMany({
      where: { workOrderId, orgId, deletedAt: null },
      take: 1000,
    });
    const coeffMap = await this.fetchPartCoefficients(parts, db);

    for (const part of parts) {
      const coeff = coeffMap[part.id] ?? 1;
      await this.inventory.createMovement(
        orgId,
        {
          goodId: part.goodId,
          warehouseId: part.warehouseId,
          type: 'RESERVATION_RELEASE',
          quantity: -(part.quantity / coeff),
          documentType: 'WorkOrder',
          documentId: workOrderId,
          createdBy: userId,
        },
        db,
      );
    }
  }

  private async writeOffPartsAndCharge(
    orgId: string,
    wo: { id: string; counterpartyId: string; totalAmount: Prisma.Decimal | null },
    userId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    const parts = await db.workOrderPart.findMany({
      where: { workOrderId: wo.id, orgId, deletedAt: null },
      take: 1000,
    });
    const coeffMap = await this.fetchPartCoefficients(parts, db);

    for (const part of parts) {
      const coeff = coeffMap[part.id] ?? 1;
      const baseQty = part.quantity / coeff;
      await this.inventory.createMovement(
        orgId,
        {
          goodId: part.goodId,
          warehouseId: part.warehouseId,
          type: 'WRITEOFF',
          quantity: -baseQty,
          price: Number(part.price),
          documentType: 'WorkOrder',
          documentId: wo.id,
          createdBy: userId,
        },
        db,
      );
      // Release the reservation that was created on IN_PROGRESS
      await this.inventory.createMovement(
        orgId,
        {
          goodId: part.goodId,
          warehouseId: part.warehouseId,
          type: 'RESERVATION_RELEASE',
          quantity: -baseQty,
          documentType: 'WorkOrder',
          documentId: wo.id,
          createdBy: userId,
        },
        db,
      );
    }
    const chargeAmount = Number(wo.totalAmount ?? 0);
    if (chargeAmount <= 0)
      throw new BadRequestException('Загальна сума наряду дорівнює нулю — завершення неможливе');
    await this.settlements.createTransaction(
      orgId,
      {
        counterpartyId: wo.counterpartyId,
        type: 'CHARGE',
        amount: chargeAmount,
        documentType: 'WorkOrder',
        documentId: wo.id,
        createdBy: userId,
      },
      db,
    );
  }

  // ─── Lines ───────────────────────────────────────────────

  async addLine(
    orgId: string,
    workOrderId: string,
    dto: CreateWorkOrderLineDto,
  ): Promise<WorkOrderLineResponseDto> {
    // Tiered parallelization — раніше було послідовно `getEditableWorkOrder` (1 RTT)
    // + Promise.all([work, employee]) (1 RTT). Об'єднуємо у єдиний Promise.all (1 RTT)
    // оскільки work і employee не залежать від результату парент-guard, а перевірка
    // статусу WO робиться після всіх awaits (порядок NotFound зберігається).
    const [wo, work, employee] = await Promise.all([
      this.prisma.workOrder.findFirst({ where: { id: workOrderId, orgId, deletedAt: null } }),
      this.prisma.work.findFirst({ where: { id: dto.workId, orgId, deletedAt: null } }),
      this.prisma.employee.findFirst({ where: { id: dto.employeeId, orgId, deletedAt: null } }),
    ]);
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (!EDITABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException('Не можна редагувати позиції наряду в поточному статусі');
    }
    if (!work) throw new NotFoundException('Роботу не знайдено');
    if (!employee) throw new NotFoundException('Співробітника не знайдено');

    const normoHours = dto.normoHours ?? work.normoHours;
    const price = dto.price !== undefined ? dto.price : Number(work.price);
    const amount = normoHours * price;

    const line = await this.prisma.$transaction(
      async tx => {
        const created = await tx.workOrderLine.create({
          data: {
            orgId,
            workOrderId,
            workId: dto.workId,
            employeeId: dto.employeeId,
            liftId: dto.liftId ?? null,
            normoHours,
            actualHours: dto.actualHours ?? null,
            price,
            amount,
            notes: dto.notes,
          },
          include: {
            work: { select: { name: true } },
            employee: { select: { firstName: true, lastName: true } },
          },
        });
        await this.recalcTotals(workOrderId, tx, orgId);
        return created;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // Bug #138: explicit timeout — create + recalcTotals (2 findMany take:1000 + update)

    return this.toLineDto(line);
  }

  async updateLine(
    orgId: string,
    workOrderId: string,
    lineId: string,
    dto: UpdateWorkOrderLineDto,
  ): Promise<WorkOrderLineResponseDto> {
    // Parallel same-aggregate parent (editable WO) + child line fetch — both
    // tenant-safe (orgId+workOrderId у where кожного запиту). -1 RTT per edit.
    const [wo, line] = await Promise.all([
      this.prisma.workOrder.findFirst({ where: { id: workOrderId, orgId, deletedAt: null } }),
      this.prisma.workOrderLine.findFirst({
        where: { id: lineId, workOrderId, orgId, deletedAt: null },
      }),
    ]);
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (!EDITABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException('Не можна редагувати позиції наряду в поточному статусі');
    }
    if (!line) throw new NotFoundException('Позицію не знайдено');

    const normoHours = dto.normoHours ?? line.normoHours;
    const price = dto.price !== undefined ? dto.price : Number(line.price);
    const amount = normoHours * price;

    const updated = await this.prisma.$transaction(
      async tx => {
        const result = await tx.workOrderLine.update({
          where: { id: lineId, orgId },
          data: {
            normoHours,
            price,
            amount,
            liftId: dto.liftId,
            notes: dto.notes,
            ...(dto.actualHours !== undefined && { actualHours: dto.actualHours }),
          },
          include: {
            work: { select: { name: true } },
            employee: { select: { firstName: true, lastName: true } },
          },
        });
        await this.recalcTotals(workOrderId, tx, orgId);
        return result;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // Bug #138: explicit timeout — update + recalcTotals

    return this.toLineDto(updated);
  }

  async removeLine(orgId: string, workOrderId: string, lineId: string): Promise<void> {
    // Parallel parent (editable WO) + child line fetch — same-aggregate same-tenant guard.
    const [wo, line] = await Promise.all([
      this.prisma.workOrder.findFirst({ where: { id: workOrderId, orgId, deletedAt: null } }),
      this.prisma.workOrderLine.findFirst({
        where: { id: lineId, workOrderId, orgId, deletedAt: null },
      }),
    ]);
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (!EDITABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException('Не можна редагувати позиції наряду в поточному статусі');
    }
    if (!line) throw new NotFoundException('Позицію не знайдено');
    await this.prisma.$transaction(
      async tx => {
        await tx.workOrderLine.update({
          where: { id: lineId, orgId },
          data: { deletedAt: new Date() },
        });
        await this.recalcTotals(workOrderId, tx, orgId);
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // Bug #138: explicit timeout — soft-delete + recalcTotals
  }

  // ─── Parts ───────────────────────────────────────────────

  async addPart(
    orgId: string,
    workOrderId: string,
    dto: CreateWorkOrderPartDto,
  ): Promise<WorkOrderPartResponseDto> {
    // Tiered parallelization — wo + good + warehouse + optional goodUoM у єдиний Promise.all.
    const [wo, good, warehouse, goodUoM] = await Promise.all([
      this.prisma.workOrder.findFirst({ where: { id: workOrderId, orgId, deletedAt: null } }),
      this.prisma.good.findFirst({ where: { id: dto.goodId, orgId, deletedAt: null } }),
      this.prisma.warehouse.findFirst({ where: { id: dto.warehouseId, orgId, deletedAt: null } }),
      dto.unitOfMeasureId
        ? this.prisma.goodUoM.findFirst({
            where: { id: dto.unitOfMeasureId, goodId: dto.goodId, orgId },
            select: { id: true, coefficient: true, unitOfMeasure: { select: { shortName: true } } },
          })
        : Promise.resolve(null),
    ]);
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (!EDITABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException('Не можна редагувати позиції наряду в поточному статусі');
    }
    if (!good) throw new NotFoundException('Товар не знайдено');
    if (!warehouse) throw new NotFoundException('Склад не знайдено');
    if (dto.unitOfMeasureId && !goodUoM) {
      throw new NotFoundException('Одиницю виміру не знайдено для цього товару');
    }

    const price = dto.price !== undefined ? dto.price : Number(good.salePrice);
    const amount = dto.quantity * price;

    const part = await this.prisma.$transaction(
      async tx => {
        const created = await tx.workOrderPart.create({
          data: {
            orgId,
            workOrderId,
            goodId: dto.goodId,
            warehouseId: dto.warehouseId,
            quantity: dto.quantity,
            price,
            amount,
            unitOfMeasureId: dto.unitOfMeasureId ?? null,
          },
          include: {
            good: {
              select: {
                name: true,
                unit: true,
                unitOfMeasure: { select: { shortName: true, coefficient: true } },
              },
            },
          },
        });
        await this.recalcTotals(workOrderId, tx, orgId);
        return { ...created, goodUoM };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // Bug #138: explicit timeout — create + recalcTotals

    return this.toPartDto(part);
  }

  async updatePart(
    orgId: string,
    workOrderId: string,
    partId: string,
    dto: UpdateWorkOrderPartDto,
  ): Promise<WorkOrderPartResponseDto> {
    // Parallel parent (editable WO) + child part fetch — same-aggregate same-tenant guard.
    const [wo, part] = await Promise.all([
      this.prisma.workOrder.findFirst({ where: { id: workOrderId, orgId, deletedAt: null } }),
      this.prisma.workOrderPart.findFirst({
        where: { id: partId, workOrderId, orgId, deletedAt: null },
      }),
    ]);
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (!EDITABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException('Не можна редагувати позиції наряду в поточному статусі');
    }
    if (!part) throw new NotFoundException('Позицію не знайдено');

    const quantity = dto.quantity ?? part.quantity;
    const price = dto.price !== undefined ? dto.price : Number(part.price);
    const amount = quantity * price;

    // Validate new unitOfMeasureId if provided
    let goodUoM: { id: string; coefficient: number; unitOfMeasure: { shortName: string } } | null =
      null;
    const newUoMId = dto.unitOfMeasureId !== undefined ? dto.unitOfMeasureId : part.unitOfMeasureId;
    if (newUoMId) {
      const goodIdForPart = dto.goodId ?? part.goodId;
      goodUoM = await this.prisma.goodUoM.findFirst({
        where: { id: newUoMId, goodId: goodIdForPart, orgId },
        select: { id: true, coefficient: true, unitOfMeasure: { select: { shortName: true } } },
      });
      if (!goodUoM) throw new NotFoundException('Одиницю виміру не знайдено для цього товару');
    }

    const updated = await this.prisma.$transaction(
      async tx => {
        const result = await tx.workOrderPart.update({
          where: { id: partId, orgId },
          data: { quantity, price, amount, unitOfMeasureId: newUoMId ?? null },
          include: {
            good: {
              select: {
                name: true,
                unit: true,
                unitOfMeasure: { select: { shortName: true, coefficient: true } },
              },
            },
          },
        });
        await this.recalcTotals(workOrderId, tx, orgId);
        return { ...result, goodUoM };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // Bug #138: explicit timeout — update + recalcTotals

    return this.toPartDto(updated);
  }

  async removePart(orgId: string, workOrderId: string, partId: string): Promise<void> {
    // Parallel parent (editable WO) + child part fetch — same-aggregate same-tenant guard.
    const [wo, part] = await Promise.all([
      this.prisma.workOrder.findFirst({ where: { id: workOrderId, orgId, deletedAt: null } }),
      this.prisma.workOrderPart.findFirst({
        where: { id: partId, workOrderId, orgId, deletedAt: null },
      }),
    ]);
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (!EDITABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException('Не можна редагувати позиції наряду в поточному статусі');
    }
    if (!part) throw new NotFoundException('Позицію не знайдено');
    await this.prisma.$transaction(
      async tx => {
        await tx.workOrderPart.update({
          where: { id: partId, orgId },
          data: { deletedAt: new Date() },
        });
        await this.recalcTotals(workOrderId, tx, orgId);
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // Bug #138: explicit timeout — soft-delete + recalcTotals
  }

  // ─── Helpers ─────────────────────────────────────────────

  private async recalcTotals(
    workOrderId: string,
    tx: Prisma.TransactionClient,
    orgId: string,
  ): Promise<void> {
    // SQL-aggregation via Prisma `aggregate({_sum})` — раніше findMany take:1000 двох колекцій
    // тягнув до 2000 рядків з amount у Node, потім reduce. Тепер SUM рахується у Postgres,
    // повертається 2 числа. Index (orgId, workOrderId, deletedAt) на обох таблицях покриває
    // WHERE — index-only scan або bitmap scan без читання heap для непотрібних колонок.
    const [linesAgg, partsAgg] = await Promise.all([
      tx.workOrderLine.aggregate({
        where: { workOrderId, orgId, deletedAt: null },
        _sum: { amount: true },
      }),
      tx.workOrderPart.aggregate({
        where: { workOrderId, orgId, deletedAt: null },
        _sum: { amount: true },
      }),
    ]);
    const totalLabor = Number(linesAgg._sum.amount ?? 0);
    const totalParts = Number(partsAgg._sum.amount ?? 0);
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
        // PDF select narrow: тягнемо лише поля що рендеряться у docDef.
        // Раніше include тягнув orgId/branchId/sortOrder/costPrice/description (lines/parts) + unit/coefficient (good)
        // які не використовуються у PDF — лише name/quantity/price/amount + work.name + good.name.
        select: {
          number: true,
          createdAt: true,
          totalAmount: true,
          vehicle: { select: { make: true, model: true, licensePlate: true } },
          counterparty: {
            select: { firstName: true, lastName: true, companyName: true, phone: true },
          },
          lines: {
            where: { deletedAt: null },
            take: 500,
            select: {
              normoHours: true,
              actualHours: true,
              price: true,
              amount: true,
              work: { select: { name: true } },
            },
          },
          parts: {
            where: { deletedAt: null },
            take: 500,
            select: {
              quantity: true,
              price: true,
              amount: true,
              good: { select: { name: true } },
            },
          },
        },
      }),
      this.prisma.organisation.findFirst({
        where: { id: orgId },
        select: { name: true, edrpou: true },
      }),
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
      works: wo.lines.map(l => ({
        name: l.work?.name ?? '',
        quantity: l.actualHours ?? l.normoHours,
        price: Number(l.price),
        total: Number(l.amount),
      })),
      parts: wo.parts.map(p => ({
        name: p.good?.name ?? '',
        quantity: p.quantity,
        price: Number(p.price),
        total: Number(p.amount),
      })),
      total: Number(wo.totalAmount),
    });
  }

  private toDto(wo: {
    id: string;
    orgId: string;
    number: string;
    status: WorkOrderStatus;
    priority: WorkOrderPriority;
    repairCategory: RepairCategory | null;
    branchId: string;
    vehicleId: string;
    counterpartyId: string;
    description: string | null;
    inMileage: number | null;
    outMileage: number | null;
    plannedAt: Date | null;
    dueDate: Date | null;
    completedAt: Date | null;
    clientApproval: boolean;
    totalLabor: Prisma.Decimal;
    totalParts: Prisma.Decimal;
    totalAmount: Prisma.Decimal;
    paidAmount: Prisma.Decimal | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt?: Date | null;
    branch?: { name: string } | null;
    vehicle?: { make: string; model: string; licensePlate: string | null } | null;
    counterparty?: {
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
    } | null;
    calendarSlots?: { startAt: Date; endAt: Date; lift: { name: string } | null }[];
    _count?: { warranties?: number } | null;
  }): WorkOrderResponseDto {
    const cp = wo.counterparty;
    const cpName = formatPersonName(cp?.lastName, cp?.firstName, cp?.companyName) || undefined;
    return {
      id: wo.id,
      orgId: wo.orgId,
      number: wo.number,
      status: wo.status,
      priority: wo.priority,
      repairCategory: wo.repairCategory ?? null,
      branchId: wo.branchId,
      branchName: wo.branch?.name,
      vehicleId: wo.vehicleId,
      vehicleSummary: wo.vehicle
        ? `${wo.vehicle.make} ${wo.vehicle.model}${wo.vehicle.licensePlate ? ` (${wo.vehicle.licensePlate})` : ''}`
        : undefined,
      counterpartyId: wo.counterpartyId,
      counterpartyName: cpName,
      description: wo.description ?? null,
      inMileage: wo.inMileage ?? null,
      outMileage: wo.outMileage ?? null,
      plannedAt: wo.plannedAt ?? null,
      dueDate: wo.dueDate ?? null,
      completedAt: wo.completedAt ?? null,
      clientApproval: wo.clientApproval,
      totalLabor: Number(wo.totalLabor),
      totalParts: Number(wo.totalParts),
      totalAmount: Number(wo.totalAmount),
      paidAmount: wo.paidAmount != null ? Number(wo.paidAmount) : 0,
      createdAt: wo.createdAt,
      updatedAt: wo.updatedAt,
      hasActiveWarranty: (wo._count?.warranties ?? 0) > 0,
      slotStartAt: wo.calendarSlots?.[0]?.startAt ?? null,
      slotEndAt: wo.calendarSlots?.[0]?.endAt ?? null,
      slotLiftName: wo.calendarSlots?.[0]?.lift?.name ?? null,
      deletedAt: wo.deletedAt ?? null,
    };
  }

  private toLineDto(line: {
    id: string;
    workOrderId: string;
    workId: string;
    employeeId: string;
    liftId: string | null;
    normoHours: number;
    actualHours: number | null;
    price: Prisma.Decimal;
    amount: Prisma.Decimal;
    notes: string | null;
    createdAt: Date;
    work?: { name: string } | null;
    employee?: { firstName: string; lastName: string } | null;
  }): WorkOrderLineResponseDto {
    return {
      id: line.id,
      workOrderId: line.workOrderId,
      workId: line.workId,
      workName: line.work?.name,
      employeeId: line.employeeId,
      employeeName: line.employee
        ? `${line.employee.lastName} ${line.employee.firstName}`
        : undefined,
      liftId: line.liftId ?? null,
      normoHours: line.normoHours,
      actualHours: line.actualHours ?? null,
      price: Number(line.price),
      amount: Number(line.amount),
      notes: line.notes ?? null,
      createdAt: line.createdAt,
    };
  }

  // Batch-fetches GoodUoM coefficients for a list of parts.
  // Returns map: partId → coefficient (1 if no UoM or not found).
  private async fetchPartCoefficients(
    parts: { id: string; unitOfMeasureId?: string | null; goodId: string }[],
    db: Prisma.TransactionClient | typeof this.prisma,
  ): Promise<Record<string, number>> {
    const uomIds = parts.map(p => p.unitOfMeasureId).filter((id): id is string => !!id);
    if (uomIds.length === 0) return {};
    const uoms = await (db as typeof this.prisma).goodUoM.findMany({
      where: { id: { in: uomIds } },
      select: { id: true, coefficient: true },
    });
    const uomCoeffById: Record<string, number> = Object.fromEntries(
      uoms.map(u => [u.id, u.coefficient]),
    );
    const result: Record<string, number> = {};
    for (const part of parts) {
      if (part.unitOfMeasureId) {
        // Bug #316: defense-in-depth. DTO `@Min(0.000001)` блокує coefficient=0 на write-path,
        // але legacy/seed/direct-SQL дані можуть мати 0. `?? 1` НЕ ловить 0
        // (nullish coalescing спрацьовує лише на null/undefined). safeCoeff() ловить 0/NaN/негативні.
        result[part.id] = safeCoeff(uomCoeffById[part.unitOfMeasureId]);
      }
    }
    return result;
  }

  private toPartDto(part: {
    id: string;
    workOrderId: string;
    goodId: string;
    warehouseId: string;
    quantity: number;
    price: Prisma.Decimal;
    amount: Prisma.Decimal;
    unitOfMeasureId?: string | null;
    createdAt: Date;
    good?: {
      name: string;
      unit: string;
      unitOfMeasure: { shortName: string; coefficient: number } | null;
    } | null;
    // Populated when unitOfMeasureId is set — per-good GoodUoM record
    goodUoM?: { id: string; coefficient: number; unitOfMeasure: { shortName: string } } | null;
  }): WorkOrderPartResponseDto {
    // If a specific GoodUoM was selected — use its shortName/coefficient.
    // Fallback to the good's base unit.
    const selectedUoM = part.goodUoM;
    const baseUoM = part.good?.unitOfMeasure;
    return {
      id: part.id,
      workOrderId: part.workOrderId,
      goodId: part.goodId,
      goodName: part.good?.name,
      unitOfMeasureId: part.unitOfMeasureId ?? null,
      unitShortName: selectedUoM?.unitOfMeasure.shortName ?? baseUoM?.shortName ?? part.good?.unit,
      // Bug #316: safeCoeff() для legacy/seed 0 — фронт використовує coefficient як дільник для display↔base conversion.
      coefficient: safeCoeff(selectedUoM?.coefficient ?? baseUoM?.coefficient),
      warehouseId: part.warehouseId,
      quantity: part.quantity,
      price: Number(part.price),
      amount: Number(part.amount),
      createdAt: part.createdAt,
    };
  }
}
