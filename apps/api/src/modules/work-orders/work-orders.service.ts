import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';

import { kyivToday } from '../../common/utils/kyiv-date';
import { safeCoeff } from '../../common/utils/math';
import { calculatePagination } from '../../common/utils/pagination';
import { assertFsmTransition } from '../../common/utils/fsm';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MaintenanceSchedulesService } from '../maintenance-schedules/maintenance-schedules.service';
import { InvoiceStatus, RepairCategory, WorkOrderPriority, WorkOrderStatus } from '@prisma/client';
import { formatPersonName, formatVehicleLabel, TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PdfService } from '../pdf/pdf.service';
import {
  WORK_ORDER_TRANSITIONS,
  CLOSED_STATUSES,
  DELETABLE_STATUSES,
  RESERVATION_ACTIVE_STATUSES,
  EDITABLE_STATUSES,
  LINE_ACTUAL_EDITABLE_STATUSES,
  SHAREABLE_STATUSES,
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
  EstimatePublicDto,
  PaginatedWorkOrdersDto,
  CreateWorkOrderLineDto,
  UpdateWorkOrderLineDto,
  WorkOrderLineResponseDto,
  CreateWorkOrderPartDto,
  UpdateWorkOrderPartDto,
  WorkOrderPartResponseDto,
} from './work-orders.dto';

// Shared select for GoodUoM lookups in addPart / updatePart.
// Centralised so the type (derived via Prisma.GoodUoMGetPayload) and the select
// clause stay in sync automatically — adding a field here updates both.
const GOOD_UOM_SELECT = {
  id: true,
  unitOfMeasureId: true,
  coefficient: true,
  unitOfMeasure: { select: { shortName: true } },
} satisfies Prisma.GoodUoMSelect;

type UomJunction = Prisma.GoodUoMGetPayload<{ select: typeof GOOD_UOM_SELECT }>;

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
    private readonly config: ConfigService,
  ) {}

  // ─── CRUD ────────────────────────────────────────────────
  // Bug #432: SHAREABLE_STATUSES перенесено у work-orders.fsm.ts для cross-module
  // експорту (FE shared mirror + completion-acts.service потенційно). Раніше
  // приватна static — тепер public expor з fsm.ts. Семантика та сама:
  // публічне share-посилання активне у DRAFT/ESTIMATE/APPROVED; після IN_PROGRESS
  // публічне посилання губить сенс, а CLOSED-статуси містять чутливі дані.

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
    if (query.dateFrom || query.dateTo) {
      where.documentDate = {
        ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
        ...(query.dateTo ? { lte: new Date(query.dateTo + 'T23:59:59.999Z') } : {}),
      };
    }

    const { skip, take } = calculatePagination({ page: query.page, limit: query.limit });
    const WO_SORT: Record<string, string> = {
      documentDate: 'documentDate',
      createdAt: 'createdAt',
      plannedAt: 'plannedAt',
      dueDate: 'dueDate',
      totalAmount: 'totalAmount',
    };
    const sortField = WO_SORT[query.sortBy ?? ''] ?? 'createdAt';
    const sortDir = query.sortDir === 'asc' ? 'asc' : 'desc';
    const [items, total] = await Promise.all([
      this.prisma.workOrder.findMany({
        where,
        skip,
        take,
        orderBy: { [sortField]: sortDir },
        include: {
          vehicle: { select: { make: true, model: true, licensePlate: true } },
          counterparty: { select: { firstName: true, lastName: true, companyName: true } },
          branch: { select: { name: true } },
          contract: { select: { id: true, number: true } },
          lift: { select: { name: true } },
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
      limit: take,
    };
  }

  async findOne(orgId: string, id: string): Promise<WorkOrderDetailDto> {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      // Bug #350: include contract so detail shows contractNumber (toDto maps it).
      include: {
        vehicle: { select: { make: true, model: true, licensePlate: true } },
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        branch: { select: { name: true } },
        contract: { select: { id: true, number: true } },
        lift: { select: { name: true } },
        // Bug review (sto-optimize 2026-06-05): defensive take cap — addLine/addPart
        // endpoints не мають ArrayMaxSize, тож теоретично WO може мати unbounded lines/parts.
        // 500 — реалістична верхня межа (PO/SD каплять на 500 у DTO), захист від OOM при
        // зловмисному infinite loop через single-add endpoints.
        lines: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 500,
          include: {
            work: { select: { name: true } },
            employee: { select: { firstName: true, lastName: true } },
          },
        },
        parts: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 500,
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
    // sto-optimize: narrow FK guards — branch/vehicle/counterparty findFirst без select
    // тягнули full row (15+ колонок кожна) лише для existence check. select:{id:true}
    // зменшує wire payload на ~80%. Lift guard уже narrow.
    //
    // Tier merger — contract validation/auto-pick об'єднано з FK guards у єдиний
    // Promise.all. Раніше: 1 RTT (4 FK parallel) + 1 RTT (contract sequential) = 2 RTT.
    // Тепер: 1 RTT (4 FK + contract parallel). Provided contractId захищає себе через
    // composite where (orgId+counterpartyId+contractType+deletedAt) — counterparty не
    // потрібен як guard. Primary auto-pick читає за (counterpartyId+orgId) — той самий
    // ключ що counterparty FK guard, але незалежний.
    const [branch, vehicle, counterparty, lift, contractResult] = await Promise.all([
      this.prisma.garageBranch.findFirst({
        where: { id: dto.branchId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.vehicle.findFirst({
        where: { id: dto.vehicleId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.counterparty.findFirst({
        where: { id: dto.counterpartyId, orgId, deletedAt: null },
        select: { id: true },
      }),
      dto.liftId
        ? this.prisma.lift.findFirst({
            where: { id: dto.liftId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.contractId
        ? this.prisma.counterpartyContract.findFirst({
            where: {
              id: dto.contractId,
              orgId,
              counterpartyId: dto.counterpartyId,
              contractType: 'SALE',
              deletedAt: null,
            },
            select: { id: true },
          })
        : this.prisma.counterpartyContract.findFirst({
            where: {
              counterpartyId: dto.counterpartyId,
              orgId,
              contractType: 'SALE',
              deletedAt: null,
            },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            select: { id: true },
          }),
    ]);
    if (!branch) throw new NotFoundException('Філію не знайдено');
    if (!vehicle) throw new NotFoundException('Автомобіль не знайдено');
    if (!counterparty) throw new NotFoundException('Контрагента не знайдено');
    if (dto.liftId && !lift) throw new NotFoundException('Підйомник не знайдено');
    // When client supplies contractId, contractResult must be a match — otherwise 404.
    // When omitted, primaryContract auto-pick — null is OK (no contract assigned).
    if (dto.contractId && !contractResult) throw new NotFoundException('Договір не знайдено');
    const contractId: string | null = contractResult?.id ?? null;

    const number = await this.docNumbers.next(orgId, 'WORK_ORDER');

    const wo = await this.prisma.workOrder.create({
      data: {
        orgId,
        branchId: dto.branchId,
        vehicleId: dto.vehicleId,
        counterpartyId: dto.counterpartyId,
        contractId,
        liftId: dto.liftId ?? null,
        number,
        description: dto.description,
        inMileage: dto.inMileage,
        priority: dto.priority ?? 'NORMAL',
        repairCategory: dto.repairCategory ?? null,
        plannedAt: dto.plannedAt ? new Date(dto.plannedAt) : null,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        plannedHours: dto.plannedHours ?? null,
        documentDate: dto.documentDate ? new Date(dto.documentDate) : kyivToday(),
      },
      include: {
        vehicle: { select: { make: true, model: true, licensePlate: true } },
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        branch: { select: { name: true } },
        contract: { select: { id: true, number: true } },
        lift: { select: { name: true } },
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
    // sto-optimize: tier merger — wo (parent guard) + optional lift FK validation у
    // єдиний Promise.all. Раніше: послідовні 2 RTT (wo, потім lift). Тепер: 1 RTT
    // паралельно. Lift FK сам себе захищає (orgId+deletedAt у where) — безпечно
    // запустити до status-перевірки. wo тримається full-row, бо trackField нижче
    // читає 8+ полів для audit diff (old values).
    const [wo, lift] = await Promise.all([
      this.prisma.workOrder.findFirst({ where: { id, orgId, deletedAt: null } }),
      dto.liftId
        ? this.prisma.lift.findFirst({
            where: { id: dto.liftId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (CLOSED_STATUSES.includes(wo.status)) {
      throw new BadRequestException('Не можна редагувати закритий наряд');
    }
    if (dto.liftId && !lift) throw new NotFoundException('Підйомник не знайдено');

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
        // Bug #433: documentDate і liftId пишуться у data (рядки нижче),
        // але були пропущені у audit-list — той самий шаблон що Bug #421.
        // Зміна дати документа / підйомника не з'являлась у AuditEvent (silent gap
        // у compliance/bookkeeping audit trail).
        'documentDate',
        'liftId',
        // Bug #421: plannedHours/actualHours були в data-payload але не у audit
        // diff — зміни нормогодин не з'являлись у AuditEvent (тихий пропуск).
        'plannedHours',
        'actualHours',
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
        documentDate: dto.documentDate ? new Date(dto.documentDate) : undefined,
        liftId: dto.liftId === undefined ? undefined : (dto.liftId ?? null),
        plannedHours: dto.plannedHours === undefined ? undefined : (dto.plannedHours ?? null),
        actualHours: dto.actualHours === undefined ? undefined : (dto.actualHours ?? null),
      },
      // Bug #350 follow-up: include contract so PATCH response carries contractNumber.
      // Without it, frontend WorkOrderDetail.contractNumber stays null after edits
      // (description/mileage/priority…) → contract row in UI disappears on save.
      include: {
        vehicle: { select: { make: true, model: true, licensePlate: true } },
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        branch: { select: { name: true } },
        contract: { select: { id: true, number: true } },
        lift: { select: { name: true } },
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
    // Narrow tenant guard — потрібен лише `status` + `number` (для audit log).
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true, number: true },
    });
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (!DELETABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException('Можна видалити лише наряд у статусі Чернетка або Скасовано');
    }
    // Race-safe updateMany з повним compound where (id+orgId+deletedAt:null).
    await this.prisma.workOrder.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
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
        liftId: true,
        description: true,
        inMileage: true,
        priority: true,
        repairCategory: true,
        dueDate: true,
        plannedHours: true,
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
        liftId: original.liftId ?? null,
        description: original.description,
        inMileage: original.inMileage,
        priority: original.priority,
        repairCategory: original.repairCategory,
        dueDate: original.dueDate,
        // Bug #426: plannedHours прочитаний з original (line 499) але НЕ записаний у
        // clone — silent loss. clone() копіює всі planning поля (dueDate, lines з normoHours,
        // parts з quantity), тож plannedHours має бути таким же — forecast має сенс зберегти.
        // actualHours навмисно ОПУЩЕНО — clone — нова DRAFT-сесія, фактичні години
        // ще не існують (симетрично з actualHours: null у lines.create нижче).
        plannedHours: original.plannedHours,
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
    // sto-optimize: narrow select — раніше `include: { parts: take:1000 }` тягнув до 1000
    // WorkOrderPart рядків для КОЖНОЇ transition(). Виявилось wo.parts не використовується
    // в цій функції: reserveParts/releasePartReservations/writeOffPartsAndCharge всі
    // re-fetch parts всередині транзакції (свіжі дані з tx-context), а решта тіла читає
    // лише status/number/outMileage/vehicleId/repairCategory/counterpartyId/totalAmount.
    // Знято overfetch для всіх 9 FSM-переходів (DRAFT→ESTIMATE, ESTIMATE→APPROVED, тощо).
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      select: {
        id: true,
        status: true,
        number: true,
        outMileage: true,
        vehicleId: true,
        repairCategory: true,
        counterpartyId: true,
        totalAmount: true,
      },
    });
    if (!wo) throw new NotFoundException('Наряд не знайдено');

    assertFsmTransition(WORK_ORDER_TRANSITIONS, wo.status, newStatus);

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
            contract: { select: { id: true, number: true } },
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
      // Logic-bug fix: release the reservation BEFORE writeoff. InventoryService.createMovement
      // gates WRITEOFF on `available = quantity - reserved >= |qty|`. Якщо весь фізичний
      // залишок зарезервовано саме цим нарядом (квантитет = резерв = baseQty), available=0
      // і WRITEOFF падає з "Недостатньо товару на складі" попри те, що фізичні запчастини
      // на складі присутні. Послідовність RELEASE → WRITEOFF: спочатку звільняємо резерв
      // (reserved -= baseQty), потім списуємо (тепер available = quantity > 0).
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
    //
    // sto-optimize: narrow projections — wo тільки для status guard,
    // work лише для normoHours/price defaults, employee лише для existence.
    // Дроп зайвих 10-20 колонок з кожного row read.
    const [wo, work, employee] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { status: true },
      }),
      this.prisma.work.findFirst({
        where: { id: dto.workId, orgId, deletedAt: null },
        select: { normoHours: true, price: true },
      }),
      this.prisma.employee.findFirst({
        where: { id: dto.employeeId, orgId, deletedAt: null },
        select: { id: true },
      }),
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
    // sto-optimize: wo narrow {status}, line narrow {normoHours, price} (для defaults).
    const [wo, line] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { status: true },
      }),
      this.prisma.workOrderLine.findFirst({
        where: { id: lineId, workOrderId, orgId, deletedAt: null },
        select: { normoHours: true, price: true },
      }),
    ]);
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    // Bug #522: дозволяємо у IN_PROGRESS/ON_HOLD ТІЛЬКИ patch'i що зачіпають
    // винятково actualHours (механік закриває фактичні години). Інші поля у тих
    // статусах = 400 («Не можна редагувати позиції наряду в поточному статусі»).
    // У EDITABLE_STATUSES (DRAFT/ESTIMATE/APPROVED) — всі поля як раніше.
    const isLineActualOnlyPatch =
      dto.workId === undefined &&
      dto.employeeId === undefined &&
      dto.liftId === undefined &&
      dto.normoHours === undefined &&
      dto.price === undefined &&
      dto.notes === undefined;
    const inEditable = EDITABLE_STATUSES.includes(wo.status);
    const inActualOnly = LINE_ACTUAL_EDITABLE_STATUSES.includes(wo.status) && isLineActualOnlyPatch;
    if (!inEditable && !inActualOnly) {
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
            // Bug #521: distinguish "field omitted" (undefined → skip) від
            // "field cleared" (null → SET NULL). Симетрія з UpdateWorkOrderDto
            // logic у `update()` (рядок 431). Без цього inline-edit що очищає
            // actualHours лагав 400 на DTO рівні; навіть якщо DTO прийняв null,
            // `dto.actualHours !== undefined && { actualHours: dto.actualHours }`
            // писало `actualHours: null` правильно — але DTO відхиляв ще до цього.
            actualHours: dto.actualHours === undefined ? undefined : (dto.actualHours ?? null),
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
    // sto-optimize: wo narrow {status}, line narrow {id} (existence only — soft-delete update нижче не читає полів).
    const [wo, line] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { status: true },
      }),
      this.prisma.workOrderLine.findFirst({
        where: { id: lineId, workOrderId, orgId, deletedAt: null },
        select: { id: true },
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
    // sto-optimize: narrow projections — wo {status}, good {salePrice} (для price default),
    // warehouse {id} (existence only).
    const [wo, good, warehouse, uomJunction] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { status: true },
      }),
      this.prisma.good.findFirst({
        where: { id: dto.goodId, orgId, deletedAt: null },
        select: { salePrice: true },
      }),
      this.prisma.warehouse.findFirst({
        where: { id: dto.warehouseId, orgId, deletedAt: null },
        select: { id: true },
      }),
      dto.unitOfMeasureId
        ? this.prisma.goodUoM.findFirst({
            where: { unitOfMeasureId: dto.unitOfMeasureId, goodId: dto.goodId, orgId },
            select: GOOD_UOM_SELECT,
          })
        : Promise.resolve(null),
    ]);
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (!EDITABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException('Не можна редагувати позиції наряду в поточному статусі');
    }
    if (!good) throw new NotFoundException('Товар не знайдено');
    if (!warehouse) throw new NotFoundException('Склад не знайдено');
    // Bug #399: fail-loudly — silent-ignore unknown UnitOfMeasureId маскує contract bugs
    // на FE (#396 — WorkOrderAddPartModal посилав GoodUoM.id у поле UnitOfMeasure.id;
    // backend silent-stored null без сигналу про втрату даних). Якщо unitOfMeasureId
    // переданий але GoodUoM запис для нього відсутній → 404 з підказкою користувачу.
    if (dto.unitOfMeasureId && !uomJunction) {
      throw new NotFoundException(
        'Одиницю виміру не сконфігуровано для цього товару. Налаштуйте у каталозі (Товари → Одиниці виміру) або виберіть базову.',
      );
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
            // Bug #420: WorkOrderPart.unitOfMeasureId FK → UnitOfMeasure.
            // uomJunction.unitOfMeasureId is the FK; uomJunction.id is the GoodUoM PK.
            unitOfMeasureId: uomJunction?.unitOfMeasureId ?? null,
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
        return { ...created, goodUoM: uomJunction };
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
    // sto-optimize: wo narrow {status}, part narrow {quantity, price, goodId, unitOfMeasureId}
    // (для defaults + goodIdForPart). Full row не потрібен — update повертає updated.
    const [wo, part] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { status: true },
      }),
      this.prisma.workOrderPart.findFirst({
        where: { id: partId, workOrderId, orgId, deletedAt: null },
        select: { quantity: true, price: true, goodId: true, unitOfMeasureId: true },
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
    let uomJunction: UomJunction | null = null;
    // dto.unitOfMeasureId = UnitOfMeasure.id (from /units); resolve to GoodUoM junction record.
    // part.unitOfMeasureId stores UnitOfMeasure.id (FK) — keep it as-is when dto doesn't override.
    const newUnitOfMeasureId = dto.unitOfMeasureId ?? null;
    if (newUnitOfMeasureId) {
      const goodIdForPart = dto.goodId ?? part.goodId;
      uomJunction = await this.prisma.goodUoM.findFirst({
        where: { unitOfMeasureId: newUnitOfMeasureId, goodId: goodIdForPart, orgId },
        select: GOOD_UOM_SELECT,
      });
      // Bug #399: fail-loudly — silent-store-null маскує FE contract bugs (#396).
      if (!uomJunction) {
        throw new NotFoundException(
          'Одиницю виміру не сконфігуровано для цього товару. Налаштуйте у каталозі (Товари → Одиниці виміру) або виберіть базову.',
        );
      }
    }

    const updated = await this.prisma.$transaction(
      async tx => {
        const result = await tx.workOrderPart.update({
          where: { id: partId, orgId },
          data: {
            quantity,
            price,
            amount,
            // Bug #420: store UnitOfMeasure.id (FK); uomJunction.id is the GoodUoM PK.
            unitOfMeasureId:
              dto.unitOfMeasureId === undefined
                ? part.unitOfMeasureId
                : (uomJunction?.unitOfMeasureId ?? null),
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
        return { ...result, goodUoM: uomJunction };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // Bug #138: explicit timeout — update + recalcTotals

    return this.toPartDto(updated);
  }

  async removePart(orgId: string, workOrderId: string, partId: string): Promise<void> {
    // Parallel parent (editable WO) + child part fetch — same-aggregate same-tenant guard.
    // sto-optimize: wo narrow {status}, part narrow {id} (existence only — soft-delete не читає полів).
    const [wo, part] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { status: true },
      }),
      this.prisma.workOrderPart.findFirst({
        where: { id: partId, workOrderId, orgId, deletedAt: null },
        select: { id: true },
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
    const vehicleLabel = formatVehicleLabel(wo.vehicle);

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
    contractId?: string | null;
    liftId?: string | null;
    description: string | null;
    inMileage: number | null;
    outMileage: number | null;
    plannedAt: Date | null;
    dueDate: Date | null;
    plannedHours?: number | null;
    actualHours?: number | null;
    completedAt: Date | null;
    clientApproval: boolean;
    totalLabor: Prisma.Decimal;
    totalParts: Prisma.Decimal;
    totalAmount: Prisma.Decimal;
    paidAmount: Prisma.Decimal | null;
    documentDate?: Date | null;
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
    contract?: { id: string; number: string } | null;
    lift?: { name: string } | null;
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
      contractId: wo.contractId ?? null,
      contractNumber: wo.contract?.number ?? null,
      liftId: wo.liftId ?? null,
      liftName: wo.lift?.name ?? null,
      description: wo.description ?? null,
      inMileage: wo.inMileage ?? null,
      outMileage: wo.outMileage ?? null,
      plannedAt: wo.plannedAt ?? null,
      dueDate: wo.dueDate ?? null,
      plannedHours: wo.plannedHours ?? null,
      actualHours: wo.actualHours ?? null,
      completedAt: wo.completedAt ?? null,
      clientApproval: wo.clientApproval,
      totalLabor: Number(wo.totalLabor),
      totalParts: Number(wo.totalParts),
      totalAmount: Number(wo.totalAmount),
      paidAmount: wo.paidAmount != null ? Number(wo.paidAmount) : 0,
      documentDate: wo.documentDate ? wo.documentDate.toISOString().slice(0, 10) : null,
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
        ? formatPersonName(line.employee.lastName, line.employee.firstName) || undefined
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

  // ─── ESTIMATE SHARE ─────────────────────────────────────────

  /**
   * Генерує (або повертає існуючий) shareToken для публічного перегляду кошторису.
   * Обмежено статусами DRAFT/ESTIMATE/APPROVED — після початку робіт ділитися немає сенсу,
   * а CLOSED-статуси (COMPLETED/INVOICED/PAID/ARCHIVED/CANCELLED) містять чутливі дані.
   *
   * Race-safe: використовує умовний update `where: { shareToken: null }` —
   * якщо інший запит щойно записав токен, цей update не зачепить рядок,
   * і ми перечитаємо актуальний токен.
   */
  async getOrCreateShareToken(orgId: string, id: string): Promise<{ token: string }> {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, status: true, shareToken: true },
    });
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    // Bug #432: SHAREABLE_STATUSES перенесено з private static у fsm.ts експорт.
    if (!SHAREABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException(
        'Поділитися кошторисом можна лише у статусі чернетка / кошторис / затверджено',
      );
    }
    if (wo.shareToken) return { token: wo.shareToken };

    const token = randomBytes(16).toString('hex');
    // updateMany з умовою shareToken: null уникає race condition:
    // якщо інший запит уже записав токен — count=0, ми перечитаємо актуальний.
    const { count } = await this.prisma.workOrder.updateMany({
      where: { id, orgId, shareToken: null, deletedAt: null },
      data: { shareToken: token },
    });
    if (count === 0) {
      const fresh = await this.prisma.workOrder.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { shareToken: true },
      });
      if (fresh?.shareToken) return { token: fresh.shareToken };
      // Малоймовірний випадок — токен зник між викликами; кидаємо як conflict.
      throw new BadRequestException('Не вдалося згенерувати токен — спробуйте ще раз');
    }
    return { token };
  }

  /**
   * Публічний перегляд кошторису. Повертає МІНІМАЛЬНИЙ DTO:
   * без orgId, FK-ів, paidAmount, slot-полів, dueDate, syncVersion тощо.
   * Доступний лише для shareable-статусів (DRAFT/ESTIMATE/APPROVED) —
   * після переходу у CLOSED-статус посилання перестає працювати (404).
   */
  async findByShareToken(token: string): Promise<EstimatePublicDto> {
    const wo = await this.prisma.workOrder.findFirst({
      where: {
        shareToken: token,
        deletedAt: null,
        // Bug #432: shared SHAREABLE_STATUSES з fsm.ts.
        status: { in: [...SHAREABLE_STATUSES] },
      },
      include: {
        vehicle: { select: { make: true, model: true, licensePlate: true } },
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        branch: { select: { name: true } },
        lines: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 500,
          select: {
            id: true,
            normoHours: true,
            price: true,
            amount: true,
            notes: true,
            work: { select: { name: true } },
          },
        },
        parts: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 500,
          select: {
            id: true,
            quantity: true,
            price: true,
            amount: true,
            unitOfMeasureId: true,
            good: {
              select: { name: true, unit: true, unitOfMeasure: { select: { shortName: true } } },
            },
          },
        },
      },
    });
    if (!wo) throw new NotFoundException('Посилання не дійсне або термін дії минув');

    const org = await this.prisma.organisation.findFirst({
      where: { id: wo.orgId },
      select: { name: true, logoUrl: true },
    });

    // Підвантажуємо per-good UoM назви одним запитом для парт, що мають окрему UoM.
    const uomIds = wo.parts.map(p => p.unitOfMeasureId).filter((x): x is string => !!x);
    const uomMap: Record<string, string> = {};
    if (uomIds.length > 0) {
      const goodUoMs = await this.prisma.goodUoM.findMany({
        where: { id: { in: uomIds } },
        select: { id: true, unitOfMeasure: { select: { shortName: true } } },
      });
      for (const u of goodUoMs) uomMap[u.id] = u.unitOfMeasure.shortName;
    }

    const cp = wo.counterparty;
    const counterpartyName =
      formatPersonName(cp?.lastName, cp?.firstName, cp?.companyName) || undefined;
    const vehicleSummary = wo.vehicle
      ? `${wo.vehicle.make} ${wo.vehicle.model}${wo.vehicle.licensePlate ? ` (${wo.vehicle.licensePlate})` : ''}`
      : undefined;

    return {
      number: wo.number,
      status: wo.status,
      orgName: org?.name,
      orgLogoUrl: org?.logoUrl ?? null,
      branchName: wo.branch?.name,
      counterpartyName,
      vehicleSummary,
      documentDate: wo.documentDate ? wo.documentDate.toISOString().slice(0, 10) : null,
      description: wo.description ?? null,
      inMileage: wo.inMileage ?? null,
      totalLabor: Number(wo.totalLabor),
      totalParts: Number(wo.totalParts),
      totalAmount: Number(wo.totalAmount),
      lines: wo.lines.map(l => ({
        id: l.id,
        workName: l.work?.name,
        normoHours: l.normoHours,
        price: Number(l.price),
        amount: Number(l.amount),
        notes: l.notes ?? null,
      })),
      parts: wo.parts.map(p => ({
        id: p.id,
        goodName: p.good?.name,
        quantity: p.quantity,
        unitShortName:
          (p.unitOfMeasureId && uomMap[p.unitOfMeasureId]) ??
          p.good?.unitOfMeasure?.shortName ??
          p.good?.unit,
        price: Number(p.price),
        amount: Number(p.amount),
      })),
    };
  }

  /**
   * Відправити SMS клієнту з посиланням на кошторис.
   * baseUrl формується на сервері з ConfigService('WEB_PUBLIC_URL') — НЕ приймається з клієнта
   * (open-redirect/phishing ризик: шкідливий каллер міг би передати `https://phishing.com`).
   */
  async sendEstimateSms(orgId: string, id: string): Promise<void> {
    const { token } = await this.getOrCreateShareToken(orgId, id);
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      select: {
        branchId: true,
        number: true,
        totalAmount: true,
        vehicle: { select: { licensePlate: true, make: true, model: true } },
        counterparty: {
          select: { phone: true, firstName: true, lastName: true, companyName: true },
        },
      },
    });
    if (!wo?.counterparty?.phone) {
      throw new BadRequestException('Телефон клієнта не вказано');
    }

    const publicUrl = this.config.get<string>('WEB_PUBLIC_URL');
    if (!publicUrl) {
      throw new BadRequestException(
        'Публічний URL не налаштовано (WEB_PUBLIC_URL) — зверніться до адміністратора',
      );
    }
    // Підрізаємо trailing slash для уніфікації — щоб не отримати `https://x.com//estimate/...`
    const link = `${publicUrl.replace(/\/+$/, '')}/estimate/${token}`;

    const clientName = formatPersonName(
      wo.counterparty.lastName,
      wo.counterparty.firstName,
      wo.counterparty.companyName,
    );
    const vehiclePlate =
      wo.vehicle?.licensePlate ?? `${wo.vehicle?.make ?? ''} ${wo.vehicle?.model ?? ''}`.trim();

    // Шаблон WO_ESTIMATE_READY очікує {{clientName}}, {{vehiclePlate}}, {{totalAmount}};
    // {{link}} і {{woNumber}} додано для нової версії шаблону (див. seed.ts).
    await this.notifications.send(orgId, 'WO_ESTIMATE_READY', {
      branchId: wo.branchId,
      phone: wo.counterparty.phone,
      clientName,
      vehiclePlate,
      totalAmount: Number(wo.totalAmount).toFixed(2),
      woNumber: wo.number,
      link,
    });
  }

  // ─── Linked Documents ──────────────────────────────────

  async getLinkedDocuments(orgId: string, workOrderId: string) {
    // No pre-existence guard: all 4 queries already filter by orgId+workOrderId, so a
    // non-existent workOrderId just returns empty arrays — same semantics, 1 fewer RTT.
    // The controller already validates the UUID format via ParseUUIDPipe.

    // §3.2/§7.1: take: N — захист від OOM при патологічних обсягах (рідко, але можливо
    // для довгоживучих нарядів з частковою оплатою або десятками перенесень слотів).
    const TAKE = 500;
    const [invoices, payments, calendarSlots, warranties] = await Promise.all([
      this.prisma.invoice.findMany({
        // Bug #415: CANCELLED інвойси виключені для узгодженості з `findByWorkOrder` і
        // `createFromWorkOrder` pre-check. Інакше badge "Документи" показує count
        // що включає cancelled → користувач думає рахунок існує, тоді як активного немає.
        where: { workOrderId, orgId, deletedAt: null, status: { not: InvoiceStatus.CANCELLED } },
        select: { id: true, number: true, status: true, amount: true, documentDate: true },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
      this.prisma.payment.findMany({
        where: { workOrderId, orgId },
        select: { id: true, amount: true, method: true, createdAt: true, notes: true },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
      this.prisma.calendarSlot.findMany({
        where: { workOrderId, orgId, deletedAt: null },
        select: {
          id: true,
          startAt: true,
          endAt: true,
          status: true,
          employeeId: true,
          notes: true,
          lift: { select: { name: true } },
        },
        orderBy: { startAt: 'desc' },
        take: TAKE,
      }),
      this.prisma.warranty.findMany({
        where: { workOrderId, orgId, deletedAt: null },
        select: {
          id: true,
          expiresAt: true,
          description: true,
          claimedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
    ]);

    // §13 API Contract: Prisma Decimal → number у DTO; Date → ISO string (JSON.stringify
    // це зробить автоматично, але якщо клієнт типує `string` — серіалізатор Fastify
    // уже повертає ISO). Decimal без cast серіалізується як рядок — фронт типує
    // `string | number`, тож приймається обидва, але нормалізація на бекенді консистентніше.
    return {
      invoices: invoices.map(i => ({ ...i, amount: Number(i.amount) })),
      payments: payments.map(p => ({ ...p, amount: Number(p.amount) })),
      calendarSlots,
      warranties,
    };
  }

  async getLinkedCounts(orgId: string, workOrderIds: string[]) {
    if (!workOrderIds.length) return {};

    const [invoices, payments, calendarSlots, warranties] = await Promise.all([
      this.prisma.invoice.groupBy({
        by: ['workOrderId'],
        // Bug #415: симетрично з getLinkedDocuments — CANCELLED виключений з counts.
        where: {
          workOrderId: { in: workOrderIds },
          orgId,
          deletedAt: null,
          status: { not: InvoiceStatus.CANCELLED },
        },
        _count: { id: true },
      }),
      this.prisma.payment.groupBy({
        by: ['workOrderId'],
        where: { workOrderId: { in: workOrderIds }, orgId },
        _count: { id: true },
      }),
      this.prisma.calendarSlot.groupBy({
        by: ['workOrderId'],
        where: { workOrderId: { in: workOrderIds }, orgId, deletedAt: null },
        _count: { id: true },
      }),
      this.prisma.warranty.groupBy({
        by: ['workOrderId'],
        where: { workOrderId: { in: workOrderIds }, orgId, deletedAt: null },
        _count: { id: true },
      }),
    ]);

    const result: Record<
      string,
      { invoices: number; payments: number; calendarSlots: number; warranties: number }
    > = {};
    for (const id of workOrderIds) {
      result[id] = { invoices: 0, payments: 0, calendarSlots: 0, warranties: 0 };
    }
    invoices.forEach(r => {
      if (r.workOrderId) result[r.workOrderId].invoices = r._count.id;
    });
    payments.forEach(r => {
      if (r.workOrderId) result[r.workOrderId].payments = r._count.id;
    });
    calendarSlots.forEach(r => {
      if (r.workOrderId) result[r.workOrderId].calendarSlots = r._count.id;
    });
    warranties.forEach(r => {
      if (r.workOrderId) result[r.workOrderId].warranties = r._count.id;
    });
    return result;
  }
}
