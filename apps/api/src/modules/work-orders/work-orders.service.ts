import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import { kyivToday } from '../../common/utils/kyiv-date';
import { money, moneyFromDecimal } from '../../common/utils/money';
import { calculatePagination, buildSortOrderBy } from '../../common/utils/pagination';
import { assertFsmTransition } from '../../common/utils/fsm';
import { assertCounterpartyRole } from '../../common/utils/counterparty-role';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkOrderStockEffectsService } from './work-order-stock-effects.service';
import { WorkOrderTotalsService } from './work-order-totals.service';
import { InvoiceStatus, RepairCategory, WorkOrderStatus } from '@prisma/client';
import {
  formatPersonName,
  formatVehicleLabel,
  TRANSACTION_TIMEOUT_MS,
  translateError,
} from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PdfService } from '../pdf/pdf.service';
import {
  WORK_ORDER_TRANSITIONS,
  CLOSED_STATUSES,
  DELETABLE_STATUSES,
  RESERVATION_ACTIVE_STATUSES,
  EDITABLE_STATUSES,
  LINE_ACTUAL_EDITABLE_STATUSES,
} from './work-orders.fsm';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import {
  WORK_ORDER_EVENTS,
  WorkOrderCompletedEvent,
  WorkOrderTransitionedEvent,
} from './events/work-order.events';
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
import {
  mapWorkOrderToDto,
  mapWorkOrderLineToDto,
  mapWorkOrderPartToDto,
} from './work-order-dto.mapper';

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

// Shared shape для всіх parts read paths (findOne/addPart/updatePart) — попереджає drift
// (sto-review 2026-06-19): кожен новий scalar тут автоматично потрапляє у всі три
// response-и + у toPartDto без ручного дублювання у трьох include shape-ах.
const PART_GOOD_INCLUDE = {
  select: {
    name: true,
    internalCode: true,
    sku: true,
    unit: true,
    unitOfMeasure: { select: { shortName: true, coefficient: true } },
    brand: { select: { name: true } },
  },
} as const satisfies Prisma.GoodDefaultArgs;

// sto-optimize (cycle 3/3): sort-field whitelist hoisted from findAll body — static string-map,
// re-allocated on every list request under polling. Sibling to SP_SORT_FIELDS/INV_SORT_FIELDS/PO_SORT_FIELDS/SD_SORT_FIELDS.
const WO_SORT_FIELDS: Record<string, string> = {
  documentDate: 'documentDate',
  createdAt: 'createdAt',
  plannedAt: 'plannedAt',
  dueDate: 'dueDate',
  totalAmount: 'totalAmount',
};

@Injectable()
export class WorkOrdersService {
  private readonly logger = new Logger(WorkOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stockEffects: WorkOrderStockEffectsService,
    private readonly docNumbers: DocumentNumberService,
    private readonly pdf: PdfService,
    private readonly audit: AuditService,
    private readonly settingsService: SettingsService,
    private readonly exchangeRates: ExchangeRatesService,
    // A2: transition() емітить доменні події; lifecycle-side-effects (пробіг/ТО/гарантія/нотифікація/
    // аудит) — у WorkOrderEventHandlers через @OnEvent.
    // A3: share/public-кошторис винесено у WorkOrderShareService; transaction-critical stock+settlement
    // side-effects переходів — у WorkOrderStockEffectsService (тому inventory/settlements більше не тут).
    // Fan-out WorkOrdersService: 11 → 7 → 6.
    private readonly events: EventEmitter2,
    // Єдиний власник складу суми наряду (BR-WO-007); його ж кличуть огляд і XLSX-імпорт запчастин.
    private readonly totals: WorkOrderTotalsService,
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
    if (query.dateFrom || query.dateTo) {
      where.documentDate = {
        ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
        ...(query.dateTo ? { lte: new Date(query.dateTo + 'T23:59:59.999Z') } : {}),
      };
    }

    const { skip, take } = calculatePagination({ page: query.page, limit: query.limit });
    const orderBy = buildSortOrderBy(WO_SORT_FIELDS, query.sortBy, query.sortDir);
    const [items, total] = await Promise.all([
      this.prisma.workOrder.findMany({
        where,
        skip,
        take,
        orderBy,
        include: {
          vehicle: { select: { make: true, model: true, licensePlate: true } },
          counterparty: { select: { firstName: true, lastName: true, companyName: true } },
          branch: { select: { name: true } },
          contract: { select: { id: true, number: true } },
          currency: { select: { code: true } },
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

  async findOne(orgId: string, id: string, userRole?: string): Promise<WorkOrderDetailDto> {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        vehicle: { select: { make: true, model: true, licensePlate: true } },
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        branch: { select: { name: true } },
        contract: { select: { id: true, number: true } },
        currency: { select: { code: true } },
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
          include: { good: PART_GOOD_INCLUDE },
        },
      },
    });
    if (!wo) throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));

    // Batch-fetch GoodUoM coefficients for parts that have unitOfMeasureId set.
    // WO-C3: part.unitOfMeasureId — FK на UnitOfMeasure.id, тож lookup за парою
    // (unitOfMeasureId, goodId), не за GoodUoM.id. Раніше збіг був неможливий → обрана
    // одиниця виміру не показувалась (тихо падала на базову).
    const partUomPairs = wo.parts
      .map(p => ({
        uomId: (p as { unitOfMeasureId?: string | null }).unitOfMeasureId,
        goodId: (p as { goodId: string }).goodId,
      }))
      .filter((x): x is { uomId: string; goodId: string } => !!x.uomId);
    const goodUoMMap = new Map<
      string,
      { coefficient: number; unitOfMeasure: { shortName: string } }
    >();
    if (partUomPairs.length > 0) {
      const goodUoMs = await this.prisma.goodUoM.findMany({
        where: {
          orgId,
          unitOfMeasureId: { in: partUomPairs.map(x => x.uomId) },
          goodId: { in: partUomPairs.map(x => x.goodId) },
        },
        select: {
          unitOfMeasureId: true,
          goodId: true,
          coefficient: true,
          unitOfMeasure: { select: { shortName: true } },
        },
      });
      for (const u of goodUoMs) goodUoMMap.set(`${u.goodId}|${u.unitOfMeasureId}`, u);
    }

    return {
      ...this.toDto(wo),
      lines: wo.lines.map(l => this.toLineDto(l)),
      parts: wo.parts.map(p => {
        const uomId = (p as { unitOfMeasureId?: string | null }).unitOfMeasureId;
        const goodId = (p as { goodId: string }).goodId;
        return this.toPartDto(
          {
            ...p,
            unitOfMeasureId: uomId,
            goodUoM: uomId ? (goodUoMMap.get(`${goodId}|${uomId}`) ?? null) : null,
          },
          userRole,
        );
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
        select: { id: true, type: true },
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
    if (!branch) throw new NotFoundException(translateError('err.branch.notFound', getLocale()));
    if (!vehicle)
      throw new NotFoundException(translateError('err.workOrder.vehicleNotFound', getLocale()));
    if (!counterparty)
      throw new NotFoundException(
        translateError('err.workOrder.counterpartyNotFound', getLocale()),
      );
    assertCounterpartyRole(counterparty.type, 'client'); // BR-CP-001
    if (dto.liftId && !lift)
      throw new NotFoundException(translateError('err.lift.notFound', getLocale()));
    // When client supplies contractId, contractResult must be a match — otherwise 404.
    // When omitted, primaryContract auto-pick — null is OK (no contract assigned).
    if (dto.contractId && !contractResult)
      throw new NotFoundException(translateError('err.workOrder.contractNotFound', getLocale()));
    const contractId: string | null = contractResult?.id ?? null;
    // Примітка: outMileage у CreateWorkOrderDto немає (виставляється лише на update/завершенні),
    // тож guard монотонності пробігу потрібен лише в update() — тут перевіряти нічого.

    const number = await this.docNumbers.next(orgId, 'WORK_ORDER');

    // Мультивалюта (Фаза 3): валюта наряду — з DTO або базова org. Тотали ще 0 (рядки додаються
    // пізніше → recalcTotals порахує totalAmountBase по курсу). Тут лише фіксуємо currencyId.
    const currencyId = dto.currencyId ?? (await this.exchangeRates.requireBaseCurrencyId(orgId));

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
        currencyId,
        documentDate: dto.documentDate ? new Date(dto.documentDate) : kyivToday(),
      },
      include: {
        vehicle: { select: { make: true, model: true, licensePlate: true } },
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        branch: { select: { name: true } },
        contract: { select: { id: true, number: true } },
        currency: { select: { code: true } },
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
    if (!wo) throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));
    if (CLOSED_STATUSES.includes(wo.status)) {
      throw new BadRequestException(translateError('err.workOrder.cannotEditClosed', getLocale()));
    }
    if (dto.liftId && !lift)
      throw new NotFoundException(translateError('err.lift.notFound', getLocale()));

    // Пробіг монотонний: вихідний ≥ вхідного. Одрук (out<in) інакше зберігся б (обидва @Min(0))
    // і зіпсував би синхронізацію Vehicle.currentMileage + розрахунок наступного ТО.
    const effIn = dto.inMileage ?? wo.inMileage;
    const effOut = dto.outMileage ?? wo.outMileage;
    if (effIn != null && effOut != null && effOut < effIn) {
      throw new BadRequestException(
        translateError('err.workOrder.outMileageLessThanIn', getLocale()),
      );
    }

    // Capture old field-values BEFORE update so AuditEvent.diff is meaningful.
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
        // documentDate and liftId changes must appear in AuditEvent — omitting them
        // silently drops date/lift mutations from the compliance audit trail.
        'documentDate',
        'liftId',
        // plannedHours/actualHours must also appear in AuditEvent — normo-hour changes
        // were silently missing from the audit diff.
        'plannedHours',
        'actualHours',
        // Мультивалюта (Фаза 3): зміна валюти документа має бути видна в аудиті.
        'currencyId',
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
        // Мультивалюта (Фаза 3): totalAmountBase/rateUsed лишаються зі старого курсу до
        // наступного recalcTotals (той самий lazy-патерн, що вже для documentDate вище) —
        // НЕ перераховуємо тут, щоб не дублювати recalc-логіку поза transaction.
        currencyId: dto.currencyId === undefined ? undefined : (dto.currencyId ?? null),
        liftId: dto.liftId === undefined ? undefined : (dto.liftId ?? null),
        plannedHours: dto.plannedHours === undefined ? undefined : (dto.plannedHours ?? null),
        actualHours: dto.actualHours === undefined ? undefined : (dto.actualHours ?? null),
      },
      // PATCH response must include contract so contractNumber doesn't vanish after any field edit.
      include: {
        vehicle: { select: { make: true, model: true, licensePlate: true } },
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        branch: { select: { name: true } },
        contract: { select: { id: true, number: true } },
        currency: { select: { code: true } },
        lift: { select: { name: true } },
      },
    });

    // AuditEvent for field-level updates (only if something actually changed)
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
    if (!wo) throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));
    if (!DELETABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException(
        translateError('err.workOrder.onlyDraftOrCancelledDeletable', getLocale()),
      );
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
        currencyId: true, // Мультивалюта (Фаза 3): клон успадковує валюту документа
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
    if (!original)
      throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));

    // Validate FK references still exist (not soft-deleted) BEFORE create.
    // Without this, FK violation surfaces as P2003 (HTTP 500) instead of a friendly 404.
    // docNumbers.next is independent of FK validation — parallelise together.
    const [vehicle, counterparty, branch, number] = await Promise.all([
      this.prisma.vehicle.findFirst({
        where: { id: original.vehicleId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.counterparty.findFirst({
        where: { id: original.counterpartyId, orgId, deletedAt: null },
        select: { id: true, type: true },
      }),
      this.prisma.garageBranch.findFirst({
        where: { id: original.branchId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.docNumbers.next(orgId, 'WORK_ORDER'),
    ]);
    if (!vehicle)
      throw new NotFoundException(
        translateError('err.workOrder.vehicleDeletedNoClone', getLocale()),
      );
    if (!counterparty)
      throw new NotFoundException(
        translateError('err.workOrder.counterpartyDeletedNoClone', getLocale()),
      );
    assertCounterpartyRole(counterparty.type, 'client'); // BR-CP-001
    if (!branch)
      throw new NotFoundException(
        translateError('err.workOrder.branchDeletedNoClone', getLocale()),
      );

    // 3-4. Клон створюється разом із рядками, а тотали рахує recalcTotals у тій самій транзакції —
    // єдине місце, що знає склад суми за режимом ПДВ (BR-WO-007) і курс на сьогодні (клон — новий
    // DRAFT, тож base-сума йде по свіжому курсу, а не по курсу оригіналу).
    const cloned = await this.prisma.$transaction(
      async tx => {
        const created = await tx.workOrder.create({
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
            // plannedHours copied from original — clone preserves all planning fields.
            // actualHours intentionally omitted — clone is a new DRAFT session, actual hours do not yet exist.
            plannedHours: original.plannedHours,
            currencyId: original.currencyId ?? null,
            lines: {
              // clones are DRAFT — actualHours reset to null; copying original value misleads labour reports for the new visit.
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
          select: { id: true },
        });
        await this.recalcTotals(created.id, tx, orgId);
        return tx.workOrder.findFirstOrThrow({
          where: { id: created.id, orgId },
          include: {
            vehicle: { select: { make: true, model: true, licensePlate: true } },
            counterparty: { select: { firstName: true, lastName: true, companyName: true } },
            branch: { select: { name: true } },
          },
        });
      },
      { timeout: 15_000 },
    ); // explicit timeout: create + recalcTotals

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
    if (!wo) throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));

    assertFsmTransition(WORK_ORDER_TRANSITIONS, wo.status, newStatus);

    const updates: { status: WorkOrderStatus; completedAt?: Date } = { status: newStatus };
    if (newStatus === 'COMPLETED') updates.completedAt = new Date();

    // All side-effects + status update run in one transaction to prevent partial state.
    // Explicit 10s timeout: COMPLETED tx does N writeoff + N release + 1 charge per part;
    // 50+ parts can exceed the 5s Prisma default.
    const updated = await this.prisma.$transaction(
      async tx => {
        // BR-WO-006 (Bug #795): чернетки актів скасованого наряду скасовуються разом із ним, у тій
        // самій транзакції. Підписані акти не чіпаємо — це вже виданий клієнтові документ.
        // Стоїть ДО CAS наряду свідомо — через порядок блокувань: CompletionActsService.sign()
        // блокує рядок акту, потім рядок наряду (COMPLETED→INVOICED). Якби тут було навпаки
        // (наряд → акт), одночасні «підписати» і «скасувати» давали б deadlock і 500 замість
        // 400 «статус змінився». Якщо CAS нижче не пройде — транзакція відкотить і цей запис.
        if (newStatus === 'CANCELLED') {
          await tx.completionAct.updateMany({
            where: { orgId, workOrderId: id, deletedAt: null, status: 'DRAFT' },
            data: { status: 'CANCELLED' },
          });
        }

        // CAS-перехід наряду — ПЕРШИМ серед записів у сам наряд, склад і борг (не stale-read!):
        // flip wo.status→newStatus атомарно у where. Без
        // цього два concurrent transition(COMPLETED) обидва проходять re-read → ПОДВІЙНИЙ CHARGE
        // (для labor-only наряду нема stockItem-lock, що інакше випадково серіалізує) + подвійний
        // WRITEOFF. count===0 → інший перехід уже стався. Дзеркалить stock-documents.transition.
        // (Заміна на CAS підсилює й single-shot-гарантію C2 returnPartsAndCredit нижче.)
        const cas = await tx.workOrder.updateMany({
          where: { id, orgId, deletedAt: null, status: wo.status },
          data: updates,
        });
        if (cas.count === 0) {
          throw new BadRequestException(translateError('err.workOrder.statusChanged', getLocale()));
        }

        // Резервувати ЛИШЕ при першому вході у IN_PROGRESS (з APPROVED). ON_HOLD зберігає
        // резерв (RESERVATION_ACTIVE_STATUSES), тож ON_HOLD→IN_PROGRESS НЕ має резервувати
        // повторно — інакше кожен цикл пауза/повернення подвоює reserved (WO-C1, фантомна нестача).
        if (newStatus === 'IN_PROGRESS' && wo.status === 'APPROVED') {
          await this.stockEffects.reserveParts(orgId, id, userId, tx);
        }

        if (newStatus === 'COMPLETED') {
          // BR-WO-008: борг нараховується за ЧИННИМИ режимом і ставкою ПДВ. Тотали наряду
          // ліниві (пишуться при правці рядків), тож наряд, створений до зміни налаштувань і
          // завершений без правок, ніс би стару суму. writeOffPartsAndCharge перечитує
          // totalAmount у цій самій транзакції — тому перерахунок стоїть перед ним.
          await this.totals.recalc(id, tx, orgId);
          await this.stockEffects.writeOffPartsAndCharge(orgId, wo, userId, tx);
        }

        if (newStatus === 'CANCELLED' && RESERVATION_ACTIVE_STATUSES.includes(wo.status)) {
          await this.stockEffects.releasePartReservations(orgId, id, userId, tx);
        }

        // C2: скасування ЗАВЕРШЕНОГО наряду — реверс складу+боргу. На COMPLETED резерв уже
        // знято (writeOffPartsAndCharge зробив RESERVATION_RELEASE+WRITEOFF), тож повертаємо
        // лише фізичні залишки+партії (RETURN) і сторнуємо CHARGE (CREDIT_NOTE). Guard
        // wo.status==='COMPLETED' → DRAFT/ESTIMATE/APPROVED/ON_HOLD→CANCELLED поведінка незмінна
        // (ті не списували запчастин). Single-shot: CAS-flip (вище) + термінальний CANCELLED →
        // емітується рівно 1× (та сама гарантія, що не дає подвійного CHARGE).
        if (newStatus === 'CANCELLED' && wo.status === 'COMPLETED') {
          await this.stockEffects.returnPartsAndCredit(orgId, wo, userId, tx);
        }

        // Статус/completedAt уже застосовані CAS-updateMany вище — тут лише fetch з include.
        return tx.workOrder.findFirstOrThrow({
          where: { id, orgId },
          include: {
            vehicle: { select: { make: true, model: true, licensePlate: true } },
            counterparty: {
              select: {
                firstName: true,
                lastName: true,
                companyName: true,
                phone: true,
                email: true,
              },
            },
            branch: { select: { name: true } },
            contract: { select: { id: true, number: true } },
            currency: { select: { code: true } },
          },
        });
      },
      { timeout: 10_000 },
    );

    // A2: lifecycle-side-effects — через доменні події (пробіг/ТО/гарантія/нотифікація/аудит
    // винесені у WorkOrderEventHandlers через @OnEvent). Емітимо ПІСЛЯ коміту транзакції. Семантика
    // збережена: best-effort, post-commit, in-process (як були inline .catch). EventEmitter2.emit
    // синхронний — async-хендлери запускаються без await, не блокують і не зривають перехід/return.

    // Аудит — на КОЖЕН перехід (хендлер сам гейтить userId).
    this.events.emit(
      WORK_ORDER_EVENTS.TRANSITIONED,
      new WorkOrderTransitionedEvent(orgId, id, wo.status, newStatus, userId),
    );

    // Завершення — несе повний контекст для хендлерів без re-fetch.
    if (newStatus === 'COMPLETED') {
      this.events.emit(
        WORK_ORDER_EVENTS.COMPLETED,
        new WorkOrderCompletedEvent(
          orgId,
          id,
          wo.vehicleId,
          updates.completedAt!,
          wo.repairCategory,
          wo.outMileage ?? null,
          updated.number,
          updated.branchId,
          {
            phone: updated.counterparty.phone,
            email: updated.counterparty.email,
            firstName: updated.counterparty.firstName,
            lastName: updated.counterparty.lastName,
            companyName: updated.counterparty.companyName,
          },
        ),
      );
    }

    return this.toDto(updated);
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
    if (!wo) throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));
    if (!EDITABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException(
        translateError('err.workOrder.cannotEditLinesInStatus', getLocale()),
      );
    }
    if (!work)
      throw new NotFoundException(translateError('err.workOrder.workNotFound', getLocale()));
    if (!employee)
      throw new NotFoundException(translateError('err.workOrder.employeeNotFound', getLocale()));

    const normoHours = dto.normoHours ?? work.normoHours;
    const price = dto.price !== undefined ? money(dto.price) : moneyFromDecimal(work.price);
    const amount = money(normoHours * price);

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
    ); // explicit timeout: create + recalcTotals (2 findMany take:1000 + update) can exceed Prisma default

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
    if (!wo) throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));
    // Allow IN_PROGRESS/ON_HOLD ONLY for patches that touch exclusively actualHours
    // (mechanic closing actual hours). Other fields in those statuses → 400.
    // In EDITABLE_STATUSES (DRAFT/ESTIMATE/APPROVED) all fields are allowed.
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
      throw new BadRequestException(
        translateError('err.workOrder.cannotEditLinesInStatus', getLocale()),
      );
    }
    if (!line)
      throw new NotFoundException(translateError('err.workOrder.lineNotFound', getLocale()));

    const normoHours = dto.normoHours ?? line.normoHours;
    const price = dto.price !== undefined ? money(dto.price) : moneyFromDecimal(line.price);
    const amount = money(normoHours * price);

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
            // Distinguish "field omitted" (undefined → skip) from "field cleared" (null → SET NULL).
            // Symmetric with UpdateWorkOrderDto.actualHours in update().
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
    ); // explicit timeout: update + recalcTotals

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
    if (!wo) throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));
    if (!EDITABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException(
        translateError('err.workOrder.cannotEditLinesInStatus', getLocale()),
      );
    }
    if (!line)
      throw new NotFoundException(translateError('err.workOrder.lineNotFound', getLocale()));
    await this.prisma.$transaction(
      async tx => {
        await tx.workOrderLine.update({
          where: { id: lineId, orgId },
          data: { deletedAt: new Date() },
        });
        await this.recalcTotals(workOrderId, tx, orgId);
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // explicit timeout: soft-delete + recalcTotals
  }

  // ─── Parts ───────────────────────────────────────────────

  async addPart(
    orgId: string,
    workOrderId: string,
    dto: CreateWorkOrderPartDto,
    // userRole passed for consistency with findOne: without it OWNER/ADMIN get a DTO
    // without costPrice after adding a part and need a full page refresh to see it.
    userRole?: string,
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
    if (!wo) throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));
    if (!EDITABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException(
        translateError('err.workOrder.cannotEditLinesInStatus', getLocale()),
      );
    }
    if (!good) throw new NotFoundException(translateError('err.good.notFound', getLocale()));
    if (!warehouse)
      throw new NotFoundException(translateError('err.workOrder.warehouseNotFound', getLocale()));
    // Fail-loudly on unknown unitOfMeasureId: silent null-store masks frontend contract bugs
    // (WorkOrderAddPartModal sent GoodUoM.id in the UnitOfMeasure.id field; backend silently
    // stored null with no signal about data loss). If provided but GoodUoM is missing → 404.
    if (dto.unitOfMeasureId && !uomJunction) {
      throw new NotFoundException(
        translateError('err.workOrder.unitNotConfiguredForGood', getLocale()),
      );
    }

    const price = dto.price !== undefined ? money(dto.price) : moneyFromDecimal(good.salePrice);
    const amount = money(dto.quantity * price);

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
            // uomJunction.unitOfMeasureId is the FK (→ UnitOfMeasure); uomJunction.id is the GoodUoM PK.
            unitOfMeasureId: uomJunction?.unitOfMeasureId ?? null,
          },
          include: { good: PART_GOOD_INCLUDE },
        });
        await this.recalcTotals(workOrderId, tx, orgId);
        return { ...created, goodUoM: uomJunction };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // explicit timeout: create + recalcTotals

    return this.toPartDto(part, userRole);
  }

  async updatePart(
    orgId: string,
    workOrderId: string,
    partId: string,
    dto: UpdateWorkOrderPartDto,
    // userRole passed symmetrically with addPart — for role-gated costPrice visibility.
    userRole?: string,
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
    if (!wo) throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));
    if (!EDITABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException(
        translateError('err.workOrder.cannotEditLinesInStatus', getLocale()),
      );
    }
    if (!part)
      throw new NotFoundException(translateError('err.workOrder.lineNotFound', getLocale()));

    const quantity = dto.quantity ?? part.quantity;
    const price = dto.price !== undefined ? money(dto.price) : moneyFromDecimal(part.price);
    const amount = money(quantity * price);

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
      // Fail-loudly: silent null-store masks frontend contract bugs.
      if (!uomJunction) {
        throw new NotFoundException(
          translateError('err.workOrder.unitNotConfiguredForGood', getLocale()),
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
            // store UnitOfMeasure.id (FK); uomJunction.id is the GoodUoM PK.
            unitOfMeasureId:
              dto.unitOfMeasureId === undefined
                ? part.unitOfMeasureId
                : (uomJunction?.unitOfMeasureId ?? null),
          },
          include: { good: PART_GOOD_INCLUDE },
        });
        await this.recalcTotals(workOrderId, tx, orgId);
        return { ...result, goodUoM: uomJunction };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // explicit timeout: update + recalcTotals

    return this.toPartDto(updated, userRole);
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
    if (!wo) throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));
    if (!EDITABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException(
        translateError('err.workOrder.cannotEditLinesInStatus', getLocale()),
      );
    }
    if (!part)
      throw new NotFoundException(translateError('err.workOrder.lineNotFound', getLocale()));
    await this.prisma.$transaction(
      async tx => {
        await tx.workOrderPart.update({
          where: { id: partId, orgId },
          data: { deletedAt: new Date() },
        });
        await this.recalcTotals(workOrderId, tx, orgId);
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // explicit timeout: soft-delete + recalcTotals
  }

  // ─── Helpers ─────────────────────────────────────────────

  private recalcTotals(
    workOrderId: string,
    tx: Prisma.TransactionClient,
    orgId: string,
  ): Promise<void> {
    return this.totals.recalc(workOrderId, tx, orgId);
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
          totalNet: true,
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
    if (!wo) throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));

    const cp = wo.counterparty;
    const counterpartyName = formatPersonName(cp?.lastName, cp?.firstName, cp?.companyName) || '';
    const vehicleLabel = formatVehicleLabel(wo.vehicle);

    return this.pdf.generateWorkOrderPdf({
      org: { name: org?.name ?? '', edrpou: org?.edrpou },
      counterparty: { name: counterpartyName, phone: cp?.phone },
      vehicleLabel,
      number: wo.number,
      date: wo.createdAt,
      works: wo.lines.map(l => {
        // totalAmount у WorkOrder уже рахується через (actualHours ?? normoHours) × price
        // (див. recalcTotals). Тут симетрично: quantity і total мають збігатися —
        // інакше у PDF "5 год × 100 ₴ = 300 ₴" (де total — це planned amount), а сума
        // рядків ≠ ЗАГАЛЬНА СУМА. Тримаємо single-source: рахуємо total з displayed quantity.
        // BR-WO-007: money() — те саме округлення рядка, що в тоталах наряду й в акті. Сирий
        // добуток форматер PDF округлював по-своєму: 0.3 год × 100.05 = 30.014999… друкувалось
        // «30,01», а в підсумок наряду цей рядок увійшов як 30.02.
        const quantity = l.actualHours ?? l.normoHours;
        const price = Number(l.price);
        return {
          name: l.work?.name ?? '',
          quantity,
          price,
          total: money(quantity * price),
        };
      }),
      parts: wo.parts.map(p => ({
        name: p.good?.name ?? '',
        quantity: p.quantity,
        price: Number(p.price),
        total: Number(p.amount),
      })),
      // BR-WO-007: до сплати — з ПДВ; сума без ПДВ і ПДВ друкуються окремо, коли ПДВ є
      total: Number(wo.totalAmount),
      totalNet: Number(wo.totalNet),
      vatTotal: money(Number(wo.totalAmount) - Number(wo.totalNet)),
    });
  }

  // DTO-мапери виділено у ./work-order-dto.mapper (TD3). Тонкі обгортки зберігають наявні
  // виклики this.toDto/this.toLineDto/this.toPartDto по всьому сервісу без змін.
  private toDto(wo: Parameters<typeof mapWorkOrderToDto>[0]): WorkOrderResponseDto {
    return mapWorkOrderToDto(wo);
  }

  private toLineDto(line: Parameters<typeof mapWorkOrderLineToDto>[0]): WorkOrderLineResponseDto {
    return mapWorkOrderLineToDto(line);
  }

  private toPartDto(
    part: Parameters<typeof mapWorkOrderPartToDto>[0],
    userRole?: string,
  ): WorkOrderPartResponseDto {
    return mapWorkOrderPartToDto(part, userRole);
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
        // CANCELLED invoices excluded for consistency with `findByWorkOrder` and
        // `createFromWorkOrder` pre-check: the "Документи" badge must not count cancelled
        // invoices — otherwise the user sees count > 0 but no active invoice exists.
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
        // Symmetric with getLinkedDocuments — CANCELLED excluded from counts.
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
