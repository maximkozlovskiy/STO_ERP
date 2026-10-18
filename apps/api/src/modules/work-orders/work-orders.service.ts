import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import { kyivToday, dateOnlyRangeFilter } from '../../common/utils/kyiv-date';
import { lineAmount, money, moneyFromDecimal } from '../../common/utils/money';
import { calculatePagination, buildSortOrderBy } from '../../common/utils/pagination';
import { assertFsmTransition } from '../../common/utils/fsm';
import { assertCounterpartyRole } from '../../common/utils/counterparty-role';
import { PrismaService } from '../../prisma/prisma.service';
import { throwIfExclusionConflict } from '../../common/utils/prisma-errors';
import type { WorkHours } from '../../common/utils/work-hours';
import { WorkOrderStockEffectsService } from './work-order-stock-effects.service';
import { WorkOrderTotalsService } from './work-order-totals.service';
import { lockWorkOrdersForUpdate } from './work-order-stock-requirements';
import {
  isWorkOrderFullyPaid,
  settleIfFullyPaidInTx,
  type WorkOrderStatusStep,
} from './work-order-status';
import { InvoiceStatus, RepairCategory, WorkOrderStatus } from '@prisma/client';
import {
  formatPersonName,
  formatVehicleLabel,
  TRANSACTION_TIMEOUT_MS,
  translateError,
  WO_INVOICE_VISIBLE_STATUSES,
} from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PdfService } from '../pdf/pdf.service';
import { OrgPrintInfoService } from '../pdf/org-print-info.service';
import {
  WORK_ORDER_TRANSITIONS,
  CLOSED_STATUSES,
  DELETABLE_STATUSES,
  EDITABLE_STATUSES,
  LINE_ACTUAL_EDITABLE_STATUSES,
} from './work-orders.fsm';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { CalendarService, CALENDAR_SLOT_EXCLUSION } from '../calendar/calendar.service';
import {
  changedPlannedDates,
  plannedDatesError,
  sameInstant,
  type PlannedDates,
} from './work-order-planned-dates';
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
  RescheduleWorkOrderDto,
  WorkOrderRescheduleResponseDto,
} from './work-orders.dto';
import {
  findMechanicOnLift,
  MECHANIC_REJECT_KEY,
  type MechanicRejectReason,
} from '../calendar/calendar-mechanic';
import type {
  CalendarSlotEdit,
  CalendarSlotResponseDto,
  CreateCalendarSlotDto,
  CreateCalendarSlotResponseDto,
} from '../calendar/calendar.dto';
import {
  chainBounds,
  movesWorkOrderSlot,
  overflowEnd,
  relinksSlot,
  workHoursBetween,
  type SlotChange,
} from './work-order-slot-move';
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

/** Include відповіді створення/зміни наряду (`toDto`): той самий для create і update. */
const WO_WRITE_INCLUDE = {
  vehicle: { select: { make: true, model: true, licensePlate: true } },
  counterparty: { select: { firstName: true, lastName: true, companyName: true } },
  branch: { select: { name: true } },
  contract: { select: { id: true, number: true } },
  currency: { select: { code: true } },
  lift: { select: { name: true } },
} as const satisfies Prisma.WorkOrderInclude;

/** 409 гонки за підйомник — тим самим перекладеним текстом, що й 400 перевірки зайнятості. */
const slotRaceMessage = (): string => translateError('err.calendar.liftBusy', getLocale());

/** Значення дати після PATCH: `undefined` — без змін, `null` — стерто. */
function nextDate(value: string | null | undefined, stored: Date | null): Date | null {
  if (value === undefined) return stored;
  return value === null ? null : new Date(value);
}

/**
 * BR-WO-027: час і підйомник запису наряду змінюються лише там, де картка наряду змінює планові
 * дати (`EDITABLE_STATUSES`: чернетка, кошторис, затверджено); інакше 400 з причиною.
 */
function assertSlotTimeEditable(status: WorkOrderStatus): void {
  if (!EDITABLE_STATUSES.includes(status))
    throw new BadRequestException(translateError('err.calendar.workOrderSlotLocked', getLocale()));
}

/**
 * BR-WO-026 (рішення власника 2026-10-19): запис наряду видаляється лише там, де картка наряду
 * змінює планові дати (`EDITABLE_STATUSES`, як BR-WO-027) — видалення стирає дати наряду.
 */
function assertSlotDeletable(status: WorkOrderStatus): void {
  if (!EDITABLE_STATUSES.includes(status))
    throw new BadRequestException(
      translateError('err.calendar.workOrderSlotDeleteLocked', getLocale()),
    );
}

/** Планові дати наряду, стерті разом із його записом календаря (BR-WO-026), — для журналу змін. */
interface DatesReleased {
  old: Record<string, unknown>;
  next: Record<string, unknown>;
}

type PaidGuardKey = 'err.workOrder.paidCannotCancel' | 'err.workOrder.paidCannotDelete';

/** BR-WO-014: 400 «спершу сторнуйте оплату», якщо наряд має сплачене > 0; інакше null. */
function paidError(
  paidAmount: Prisma.Decimal | number,
  key: PaidGuardKey,
): BadRequestException | null {
  const paid = moneyFromDecimal(paidAmount);
  return paid > 0
    ? new BadRequestException(translateError(key, getLocale(), { paid: paid.toFixed(2) }))
    : null;
}

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
    // Реквізити й логотип організації для шапки друкованого наряд-замовлення.
    private readonly orgPrintInfo: OrgPrintInfoService,
    // BR-WO-019/020: робочі години філії для планових дат і запис календаря наряду.
    private readonly calendar: CalendarService,
  ) {}

  // ─── CRUD ────────────────────────────────────────────────

  /**
   * BR-WO-019: 400, якщо змінена планова дата в минулому, поза робочими годинами філії наряду
   * або завершення не пізніше за початок. Години філії читаються лише коли дата змінюється;
   * повертаються, щоб запис календаря (BR-WO-020) не читав їх удруге.
   */
  private async assertPlannedDates(
    orgId: string,
    branchId: string,
    next: PlannedDates,
    prev: PlannedDates | null,
  ): Promise<WorkHours | null> {
    const changed = changedPlannedDates(next, prev);
    if (!changed.start && !changed.end) return null;
    const hours = await this.calendar.resolveWorkHours(orgId, branchId);
    const err = plannedDatesError(next, prev, new Date(), hours);
    if (err) {
      throw new BadRequestException(
        translateError(err.key, getLocale(), 'params' in err ? err.params : undefined),
      );
    }
    return hours;
  }

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
    // documentDate - date without time (@db.Date): bounds are calendar dates, no timezone shift.
    const documentDate = dateOnlyRangeFilter(query.dateFrom, query.dateTo);
    if (documentDate) where.documentDate = documentDate;

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

  /**
   * BR-WO-012: `withDeleted` знімає фільтр `deletedAt: null` (orgId лишається) — лише для
   * перегляду документа, позначеного на видалення. Прапорець передає ТІЛЬКИ маршрут `GET :id`;
   * усі внутрішні виклики йдуть без нього й бачать лише невидалені.
   */
  async findOne(
    orgId: string,
    id: string,
    userRole?: string,
    opts: { withDeleted?: boolean } = {},
  ): Promise<WorkOrderDetailDto> {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, orgId, ...(opts.withDeleted === true ? {} : { deletedAt: null }) },
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

    // BR-WO-019: планові дати нового наряду — не в минулому й у робочих годинах його філії.
    const planned: PlannedDates = {
      plannedAt: dto.plannedAt ? new Date(dto.plannedAt) : null,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
    };
    // Мультивалюта (Фаза 3): валюта наряду — з DTO або базова org. Тотали ще 0 (рядки додаються
    // пізніше → recalcTotals порахує totalAmountBase по курсу). Тут лише фіксуємо currencyId.
    // Обидві перевірки незалежні й ідуть ДО номера: відмова не спалює номер документа.
    const [hours, currencyId] = await Promise.all([
      this.assertPlannedDates(orgId, dto.branchId, planned, null),
      dto.currencyId ?? this.exchangeRates.requireBaseCurrencyId(orgId),
    ]);

    const number = await this.docNumbers.next(orgId, 'WORK_ORDER');

    const createWo = (db: Prisma.TransactionClient) =>
      db.workOrder.create({
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
          plannedAt: planned.plannedAt,
          dueDate: planned.dueDate,
          plannedHours: dto.plannedHours ?? null,
          currencyId,
          documentDate: dto.documentDate ? new Date(dto.documentDate) : kyivToday(),
        },
        include: WO_WRITE_INCLUDE,
      });

    // BR-WO-020: наряд із плановими початком і завершенням сам має запис календаря — у тій самій
    // транзакції: зайнятий підйомник чи механік (400) не лишає наряду без запису.
    const { plannedAt, dueDate } = planned;
    const wo =
      plannedAt && dueDate
        ? await this.prisma
            .$transaction(
              async tx => {
                const created = await createWo(tx);
                await this.calendar.upsertWorkOrderSlot(tx, {
                  orgId,
                  workOrderId: created.id,
                  branchId: dto.branchId,
                  liftId: dto.liftId ?? null,
                  startAt: plannedAt,
                  endAt: dueDate,
                  vehicleId: dto.vehicleId,
                  counterpartyId: dto.counterpartyId,
                  ...(hours && { hours }),
                  isNew: true,
                });
                return created;
              },
              { timeout: TRANSACTION_TIMEOUT_MS },
            )
            .catch((e: unknown) =>
              throwIfExclusionConflict(e, CALENDAR_SLOT_EXCLUSION, slotRaceMessage()),
            )
        : await createWo(this.prisma);

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
    return (await this.applyUpdate(orgId, id, dto, userId)).workOrder;
  }

  /**
   * BR-WO-023: запис наряду перетягнуто в календарі. Планові початок і завершення наряду
   * зсуваються на ту саму різницю, що й перетягнутий запис ланцюжка (тривалість зберігається),
   * перенесення на рядок іншого підйомника змінює підйомник наряду. Далі — той самий шлях, що й
   * `PATCH /work-orders/:id`: BR-WO-019 (не в минулому, робочі години філії), BR-WO-020 (запис
   * на дні, зайнятість підйомника й механіка) і механік за BR-CAL-012 — будь-яка відмова 400, ні
   * наряд, ні записи не змінюються.
   *
   * Наряд без планових дат (запис прив'язано формою календаря до наряду без дат): база — межі
   * ланцюжка перетягнутого запису (якір і його продовження), тож наряд отримує дати запису.
   *
   * BR-WO-027: лише в статусах, де картка змінює планові дати (`EDITABLE_STATUSES`), інакше 400.
   */
  async reschedule(
    orgId: string,
    id: string,
    dto: RescheduleWorkOrderDto,
    userId?: string,
  ): Promise<WorkOrderRescheduleResponseDto> {
    const [wo, slot] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { plannedAt: true, dueDate: true, status: true },
      }),
      this.prisma.calendarSlot.findFirst({
        where: { id: dto.slotId, orgId, workOrderId: id, deletedAt: null },
        select: { id: true, startAt: true, parentSlotId: true },
      }),
    ]);
    if (!wo) throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));
    if (!slot)
      throw new NotFoundException(translateError('err.calendar.slotNotFound', getLocale()));
    assertSlotTimeEditable(wo.status);

    const shiftMs = new Date(dto.startAt).getTime() - slot.startAt.getTime();
    let base: { start: Date; end: Date };
    if (wo.plannedAt && wo.dueDate) {
      base = { start: wo.plannedAt, end: wo.dueDate };
    } else {
      const anchorId = slot.parentSlotId ?? slot.id;
      const chain = await this.prisma.calendarSlot.findMany({
        where: {
          orgId,
          workOrderId: id,
          deletedAt: null,
          OR: [{ id: anchorId }, { parentSlotId: anchorId }],
        },
        select: { startAt: true, endAt: true },
        take: 500,
      });
      base = {
        start: new Date(Math.min(...chain.map(c => c.startAt.getTime()))),
        end: new Date(Math.max(...chain.map(c => c.endAt.getTime()))),
      };
    }
    const shifted = (d: Date) => new Date(d.getTime() + shiftMs).toISOString();
    const { workOrder, mechanicDroppedReason } = await this.applyUpdate(
      orgId,
      id,
      {
        plannedAt: shifted(base.start),
        dueDate: shifted(base.end),
        ...(dto.liftId !== undefined && { liftId: dto.liftId }),
      },
      userId,
    );
    return {
      id: workOrder.id,
      plannedAt: workOrder.plannedAt ?? null,
      dueDate: workOrder.dueDate ?? null,
      liftId: workOrder.liftId ?? null,
      ...(mechanicDroppedReason && { mechanicDropped: true, mechanicDroppedReason }),
    };
  }

  /**
   * BR-WO-024: зміна запису календаря — `PATCH /calendar/slots/:id` (форма запису, зміна меж у
   * «Дні») і синхронізація з планшета. Час чи підйомник запису, що належить наряду, змінюють
   * наряд (`moveWorkOrderSlot`) — лише в статусах, де картка змінює дати (BR-WO-027); зміна лише
   * примітки чи механіка, запис без наряду — як раніше, самим записом (`CalendarService.updateSlot`).
   * Зміна наряду запису — перев'язка (BR-WO-028) чи відв'язка: попередній наряд утрачає запис і
   * свої планові дати (як BR-WO-026).
   *
   * Відповідь — запис після зміни; коли зміну провів наряд — якір його запису (продовження
   * перебудовуються з новими id).
   */
  async updateCalendarSlot(
    orgId: string,
    id: string,
    dto: CalendarSlotEdit,
    userId?: string,
  ): Promise<CalendarSlotResponseDto> {
    const slot = await this.prisma.calendarSlot.findFirst({
      where: { id, orgId, deletedAt: null },
      select: {
        id: true,
        workOrderId: true,
        parentSlotId: true,
        startAt: true,
        endAt: true,
        liftId: true,
        employeeId: true,
      },
    });
    if (slot && relinksSlot(slot, dto)) {
      if (dto.workOrderId)
        return this.relinkCalendarSlot(orgId, slot, dto.workOrderId, dto, userId);
      if (slot.workOrderId)
        return this.unlinkCalendarSlot(
          orgId,
          { ...slot, workOrderId: slot.workOrderId },
          dto,
          userId,
        );
    }
    const workOrderId = slot?.workOrderId;
    if (!slot || !workOrderId) return this.calendar.updateSlot(orgId, id, dto);
    // Bug #902: запис багатоденного наряду (якір чи продовження) — один ланцюжок. Механік і
    // примітку `CalendarService.updateSlot` якорю з продовженням відмовляв («редагуйте кожен
    // окремо»), а на продовженні вони губились при перебудові ланцюжка. Тож будь-яка його зміна
    // — шляхом наряду, для всього ланцюжка; у наряду не в редагованому статусі примітка й механік
    // пишуться в ланцюжок без наряду (BR-WO-027, `moveWorkOrderSlot`).
    const moves = movesWorkOrderSlot(slot, dto);
    const viaWorkOrder = moves || (await this.isSlotChain(orgId, slot));
    if (!viaWorkOrder) return this.calendar.updateSlot(orgId, id, dto);

    const mechanicDroppedReason = await this.moveWorkOrderSlot(
      orgId,
      { ...slot, workOrderId },
      dto,
      userId,
      moves,
    );
    return this.workOrderAnchor(orgId, workOrderId, mechanicDroppedReason);
  }

  /**
   * Новий запис календаря (`POST /calendar/slots`, форма «+ Слот»). Запис без наряду — як раніше,
   * `CalendarService.createSlot`. Запис для наряду — запис НАРЯДУ, як перев'язка (BR-WO-028, Bug #905):
   *
   * - наряд має планові дати → запис наряду на його датах і підйомнику (один запис на наряд,
   *   BR-WO-020: наявний запис наряду отримує механіка й примітку форми, другого не з'являється);
   * - дат немає → час (поділ на робочі дні) і підйомник форми стають плановими датами й підйомником
   *   наряду (BR-WO-019, нормогодини — Bug #903), запис створює збереження наряду.
   *
   * Лише в статусах, де картка змінює планові дати (BR-WO-027), скасований наряд — 400 (BR-WO-022);
   * механік — закріплений за підйомником запису (BR-CAL-012). Відмова — нічого не змінено.
   */
  async createCalendarSlot(
    orgId: string,
    dto: CreateCalendarSlotDto,
    userId?: string,
  ): Promise<CreateCalendarSlotResponseDto> {
    const workOrderId = dto.workOrderId;
    if (!workOrderId) return this.calendar.createSlot(orgId, dto);
    const wo = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, orgId, deletedAt: null },
      select: { status: true, branchId: true, plannedAt: true, dueDate: true, liftId: true },
    });
    if (!wo)
      throw new NotFoundException(translateError('err.calendar.workOrderNotFound', getLocale()));
    if (wo.status === WorkOrderStatus.CANCELLED)
      throw new BadRequestException(translateError('err.calendar.workOrderCancelled', getLocale()));
    assertSlotTimeEditable(wo.status);

    let datesDto: UpdateWorkOrderDto = {};
    let liftId = wo.liftId;
    if (wo.plannedAt === null || wo.dueDate === null) {
      const startAt = new Date(dto.startAt);
      const rawEnd = new Date(dto.endAt);
      if (Number.isNaN(startAt.getTime()) || Number.isNaN(rawEnd.getTime()))
        throw new BadRequestException(
          translateError('err.calendar.invalidDateFormat', getLocale()),
        );
      if (rawEnd <= startAt)
        throw new BadRequestException(translateError('err.calendar.endBeforeStart', getLocale()));
      const hours = await this.calendar.resolveWorkHours(orgId, wo.branchId);
      const endAt = overflowEnd(startAt, rawEnd, hours);
      liftId = dto.liftId ?? null;
      datesDto = {
        plannedAt: startAt.toISOString(),
        dueDate: endAt.toISOString(),
        plannedHours: workHoursBetween(startAt, endAt, hours),
        ...(liftId !== wo.liftId && { liftId }),
      };
    }
    const employeeId = dto.employeeId ?? null;
    if (employeeId) await this.assertSlotMechanic(orgId, employeeId, liftId);

    await this.applyUpdate(orgId, workOrderId, datesDto, userId, {
      forceSlot: true,
      slot: {
        // Механік форми чи збережений на записі наряду; «без механіка» нового запису поля не шле.
        ...(employeeId && { employeeId }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
      },
    });
    return { slots: await this.calendar.findWorkOrderSlots(orgId, workOrderId) };
  }

  /** Якір запису наряду після зміни — відповідь `PATCH /calendar/slots/:id`, що пройшов наряд. */
  private async workOrderAnchor(
    orgId: string,
    workOrderId: string,
    mechanicDroppedReason: MechanicRejectReason | null = null,
  ): Promise<CalendarSlotResponseDto> {
    const anchor = await this.calendar.findWorkOrderAnchor(orgId, workOrderId);
    if (!anchor)
      throw new NotFoundException(translateError('err.calendar.slotNotFound', getLocale()));
    return mechanicDroppedReason
      ? { ...anchor, mechanicDropped: true, mechanicDroppedReason }
      : anchor;
  }

  /** Запис — частина багатоденного ланцюжка: продовження або якір, що має продовження. */
  private async isSlotChain(
    orgId: string,
    slot: { id: string; parentSlotId: string | null },
  ): Promise<boolean> {
    if (slot.parentSlotId) return true;
    const continuation = await this.prisma.calendarSlot.findFirst({
      where: { orgId, parentSlotId: slot.id, deletedAt: null },
      select: { id: true },
    });
    return continuation !== null;
  }

  /** Ланцюжок запису (якір і продовження) — один запис календаря на кілька днів. */
  private slotChain(orgId: string, slot: { id: string; parentSlotId: string | null }) {
    const anchorId = slot.parentSlotId ?? slot.id;
    return this.prisma.calendarSlot.findMany({
      where: { orgId, deletedAt: null, OR: [{ id: anchorId }, { parentSlotId: anchorId }] },
      select: { id: true, startAt: true, endAt: true },
      take: 500,
    });
  }

  /**
   * BR-WO-024: запис наряду отримав новий час чи підйомник. Нові межі ланцюжка запису (якір і
   * продовження) стають плановими початком і завершенням наряду, підйомник запису — підйомником
   * наряду; далі — той самий шлях, що й `PATCH /work-orders/:id` (`applyUpdate`): BR-WO-019,
   * BR-WO-020 і BR-CAL-012. Механік, обраний явно (форма, планшет), перевіряється тут і відповідає
   * 400, як форма запису; `dropMechanicNotOnLift` знімає свого механіка (BR-CAL-012). Будь-яка
   * відмова — до запису чи в транзакції наряду: ні наряд, ні записи не змінюються.
   *
   * `moves` — змінюється час чи підйомник: лише в редагованих статусах наряду (BR-WO-027).
   * Повертає причину, з якої механіка знято, або `null`.
   */
  private async moveWorkOrderSlot(
    orgId: string,
    slot: {
      id: string;
      workOrderId: string;
      parentSlotId: string | null;
      startAt: Date;
      endAt: Date;
      liftId: string | null;
      employeeId: string | null;
    },
    change: SlotChange & {
      employeeId?: string | null | undefined;
      notes?: string | null | undefined;
      dropMechanicNotOnLift?: boolean | undefined;
    },
    userId: string | undefined,
    moves: boolean,
  ): Promise<MechanicRejectReason | null> {
    const { workOrderId } = slot;
    const [wo, chain] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { branchId: true, plannedAt: true, dueDate: true, liftId: true, status: true },
      }),
      this.slotChain(orgId, slot),
    ]);
    if (!wo) throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));
    if (moves) assertSlotTimeEditable(wo.status);

    const startAt = change.startAt != null ? new Date(change.startAt) : slot.startAt;
    const rawEnd = change.endAt != null ? new Date(change.endAt) : slot.endAt;
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(rawEnd.getTime()))
      throw new BadRequestException(translateError('err.calendar.invalidDateFormat', getLocale()));
    if (rawEnd <= startAt)
      throw new BadRequestException(translateError('err.calendar.endBeforeStart', getLocale()));
    const hours = await this.calendar.resolveWorkHours(orgId, wo.branchId);
    const bounds = chainBounds(chain, slot.id, {
      startAt,
      endAt: overflowEnd(startAt, rawEnd, hours),
    });

    const liftId = change.liftId !== undefined ? (change.liftId ?? null) : slot.liftId;
    const employeeId = change.employeeId !== undefined ? change.employeeId : slot.employeeId;
    const keepsOwnMechanic = employeeId === slot.employeeId;
    if (
      employeeId &&
      (!keepsOwnMechanic || liftId !== slot.liftId) &&
      !(change.dropMechanicNotOnLift === true && keepsOwnMechanic)
    ) {
      await this.assertSlotMechanic(orgId, employeeId, liftId);
    }

    // BR-WO-027: наряд не в редагованому статусі (час і підйомник уже відмовлено вище) — примітка
    // й механік ланцюжка пишуться в сам ланцюжок, а не через наряд: збереження наряду закритий
    // наряд не редагує (400), а ланцюжок, що розійшовся з нарядом, переписав би його дати.
    if (!EDITABLE_STATUSES.includes(wo.status)) {
      await this.calendar.updateSlotChainDetails(orgId, chain, {
        employeeId: change.employeeId,
        notes: change.notes,
      });
      return null;
    }

    // У наряд — лише те, що змінилось: зміна механіка чи примітки ланцюжка (Bug #902) не пише в
    // журнал наряду порожню зміну дат. Нова тривалість — нові планові нормогодини, як у картці
    // (Bug #903).
    const same = (a: Date | null, b: Date) => a !== null && a.getTime() === b.getTime();
    const nextHours = workHoursBetween(bounds.start, bounds.end, hours);
    const prevHours =
      wo.plannedAt && wo.dueDate ? workHoursBetween(wo.plannedAt, wo.dueDate, hours) : null;
    const { mechanicDroppedReason } = await this.applyUpdate(
      orgId,
      workOrderId,
      {
        ...(!same(wo.plannedAt, bounds.start) && { plannedAt: bounds.start.toISOString() }),
        ...(!same(wo.dueDate, bounds.end) && { dueDate: bounds.end.toISOString() }),
        ...(liftId !== wo.liftId && { liftId }),
        ...(nextHours !== prevHours && { plannedHours: nextHours }),
      },
      userId,
      {
        forceSlot: true,
        slot: {
          ...(change.employeeId !== undefined && { employeeId: change.employeeId }),
          ...(change.notes !== undefined && { notes: change.notes }),
        },
      },
    );
    return mechanicDroppedReason;
  }

  /** BR-CAL-012: механік, обраний явно, — активний MECHANIC, закріплений за підйомником; інакше 400. */
  private async assertSlotMechanic(
    orgId: string,
    employeeId: string,
    liftId: string | null,
  ): Promise<void> {
    const mechanic = await findMechanicOnLift(this.prisma, orgId, employeeId, liftId);
    if (!mechanic.ok)
      throw new BadRequestException(
        translateError(MECHANIC_REJECT_KEY[mechanic.reason], getLocale()),
      );
  }

  /**
   * BR-WO-026: запис наряду видалено (форма «Видалити» — `DELETE /calendar/slots/:id`, видалення
   * з планшета). В одній транзакції позначається видаленим увесь ланцюжок записів наряду, а
   * планові початок і завершення наряду стираються (нормогодини, виведені з дат, — теж). Запис
   * без наряду — як раніше, сам (`CalendarService.removeSlot`).
   *
   * Лише в статусах, де картка змінює планові дати (`EDITABLE_STATUSES`, як BR-WO-027; рішення
   * власника 2026-10-19): інакше 400 з причиною — і до транзакції, і під блокуванням наряду
   * (перехід «В роботу» поруч інакше стер би дати наряду, що вже в роботі).
   */
  async removeCalendarSlot(orgId: string, id: string, userId?: string): Promise<void> {
    const slot = await this.prisma.calendarSlot.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { workOrderId: true },
    });
    if (!slot)
      throw new NotFoundException(translateError('err.calendar.slotNotFound', getLocale()));
    const { workOrderId } = slot;
    if (!workOrderId) return this.calendar.removeSlot(orgId, id);
    const wo = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, orgId, deletedAt: null },
      select: { status: true, branchId: true },
    });
    if (wo) assertSlotDeletable(wo.status);
    const hours = await this.calendar.resolveWorkHours(orgId, wo?.branchId ?? null);
    const audit = await this.prisma.$transaction(
      tx => this.releaseWorkOrderDates(tx, orgId, workOrderId, hours, { editableOnly: true }),
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    this.recordDatesReleased(orgId, workOrderId, userId, audit);
  }

  /**
   * BR-WO-028: запис календаря перев'язано на інший наряд (форма, планшет; і запис без наряду,
   * якому вперше дали наряд). Обидва наряди — у редагованих статусах (BR-WO-027), інакше 400.
   *
   * - Новий наряд має планові дати → ланцюжок запису стає на його дати й підйомник.
   * - Дат немає → межі ланцюжка запису після зміни (як `moveWorkOrderSlot`) і підйомник запису
   *   стають плановими датами й підйомником нового наряду (BR-WO-019, нормогодини — Bug #903).
   *
   * Перевірки — шляхом збереження наряду (`applyUpdate`: BR-WO-019, BR-WO-020); механік, обраний у
   * формі чи збережений, — закріплений за підйомником запису (BR-CAL-012), інакше 400. В одній
   * транзакції: інші записи нового наряду позначаються видаленими (один запис на наряд — цей),
   * попередній наряд утрачає свої записи й планові дати (як BR-WO-026). Будь-яка відмова — нічого
   * не змінено.
   */
  private async relinkCalendarSlot(
    orgId: string,
    slot: {
      id: string;
      workOrderId: string | null;
      parentSlotId: string | null;
      startAt: Date;
      endAt: Date;
      liftId: string | null;
      employeeId: string | null;
    },
    newWorkOrderId: string,
    change: CalendarSlotEdit,
    userId?: string,
  ): Promise<CalendarSlotResponseDto> {
    const oldWorkOrderId = slot.workOrderId;
    const [target, previous, chain] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: newWorkOrderId, orgId, deletedAt: null },
        select: {
          status: true,
          branchId: true,
          plannedAt: true,
          dueDate: true,
          liftId: true,
          vehicleId: true,
          counterpartyId: true,
        },
      }),
      oldWorkOrderId
        ? this.prisma.workOrder.findFirst({
            where: { id: oldWorkOrderId, orgId, deletedAt: null },
            select: { status: true, branchId: true },
          })
        : Promise.resolve(null),
      this.slotChain(orgId, slot),
    ]);
    if (!target)
      throw new NotFoundException(translateError('err.calendar.workOrderNotFound', getLocale()));
    if (target.status === WorkOrderStatus.CANCELLED)
      throw new BadRequestException(translateError('err.calendar.workOrderCancelled', getLocale()));
    if (
      !EDITABLE_STATUSES.includes(target.status) ||
      (previous && !EDITABLE_STATUSES.includes(previous.status))
    )
      throw new BadRequestException(
        translateError('err.calendar.workOrderRelinkLocked', getLocale()),
      );

    const hasDates = target.plannedAt !== null && target.dueDate !== null;
    const hours = await this.calendar.resolveWorkHours(orgId, target.branchId);
    let datesDto: UpdateWorkOrderDto = {};
    let liftId = target.liftId;
    if (!hasDates) {
      const startAt = change.startAt != null ? new Date(change.startAt) : slot.startAt;
      const rawEnd = change.endAt != null ? new Date(change.endAt) : slot.endAt;
      if (Number.isNaN(startAt.getTime()) || Number.isNaN(rawEnd.getTime()))
        throw new BadRequestException(
          translateError('err.calendar.invalidDateFormat', getLocale()),
        );
      if (rawEnd <= startAt)
        throw new BadRequestException(translateError('err.calendar.endBeforeStart', getLocale()));
      const bounds = chainBounds(chain, slot.id, {
        startAt,
        endAt: overflowEnd(startAt, rawEnd, hours),
      });
      liftId = change.liftId !== undefined ? (change.liftId ?? null) : slot.liftId;
      datesDto = {
        plannedAt: bounds.start.toISOString(),
        dueDate: bounds.end.toISOString(),
        plannedHours: workHoursBetween(bounds.start, bounds.end, hours),
        ...(liftId !== target.liftId && { liftId }),
      };
    }

    const employeeId = change.employeeId !== undefined ? change.employeeId : slot.employeeId;
    if (employeeId && (employeeId !== slot.employeeId || liftId !== slot.liftId))
      await this.assertSlotMechanic(orgId, employeeId, liftId);

    const chainIds = chain.map(s => s.id);
    const previousHours =
      oldWorkOrderId && previous
        ? await this.calendar.resolveWorkHours(orgId, previous.branchId)
        : null;
    let released: DatesReleased | null = null;
    await this.applyUpdate(orgId, newWorkOrderId, datesDto, userId, {
      forceSlot: true,
      slot: {
        employeeId,
        ...(change.notes !== undefined && { notes: change.notes }),
      },
      inTx: async tx => {
        // Порядок блокувань: обидва наряди — за id і до записів календаря (як `applyUpdate`: наряд
        // → записи). Інакше зустрічні перев'язки (A→B і B→A) блокують наряди навхрест — deadlock і
        // 500. Статуси — ще раз під блокуванням: перехід наряду між перевіркою вище й транзакцією
        // інакше стер би дати наряду «В роботі» (BR-WO-027).
        await this.lockRelinkedWorkOrders(tx, orgId, newWorkOrderId, oldWorkOrderId);
        // Один запис на наряд (BR-WO-020): цей ланцюжок замінює наявні записи нового наряду.
        await tx.calendarSlot.updateMany({
          where: {
            orgId,
            workOrderId: newWorkOrderId,
            deletedAt: null,
            id: { notIn: chainIds },
          },
          data: { deletedAt: new Date() },
        });
        await tx.calendarSlot.updateMany({
          where: { orgId, id: { in: chainIds }, deletedAt: null },
          data: {
            workOrderId: newWorkOrderId,
            counterpartyId: target.counterpartyId,
            vehicleId: target.vehicleId,
          },
        });
        if (oldWorkOrderId && previousHours)
          released = await this.releaseWorkOrderDates(tx, orgId, oldWorkOrderId, previousHours);
      },
    });
    if (oldWorkOrderId) this.recordDatesReleased(orgId, oldWorkOrderId, userId, released);
    return this.workOrderAnchor(orgId, newWorkOrderId);
  }

  /**
   * Перев'язка в транзакції `tx`: блокує новий і попередній наряди в порядку id
   * (`lockWorkOrdersForUpdate`) і перечитує їх під блокуванням — новий наряд живий, обидва в
   * редагованих статусах (BR-WO-027); інакше 404 / 400, транзакція відкочується.
   */
  private async lockRelinkedWorkOrders(
    tx: Prisma.TransactionClient,
    orgId: string,
    newWorkOrderId: string,
    oldWorkOrderId: string | null,
  ): Promise<void> {
    const ids = oldWorkOrderId ? [newWorkOrderId, oldWorkOrderId] : [newWorkOrderId];
    await lockWorkOrdersForUpdate(tx, orgId, ids);
    const rows = await tx.workOrder.findMany({
      where: { orgId, id: { in: ids }, deletedAt: null },
      select: { id: true, status: true },
      take: ids.length,
    });
    if (!rows.some(r => r.id === newWorkOrderId))
      throw new NotFoundException(translateError('err.calendar.workOrderNotFound', getLocale()));
    if (rows.some(r => !EDITABLE_STATUSES.includes(r.status)))
      throw new BadRequestException(
        translateError('err.calendar.workOrderRelinkLocked', getLocale()),
      );
  }

  /**
   * Запис наряду відв'язано від наряду (форма «×», `workOrderId: null` з планшета): за BR-WO-026
   * наряд утрачає запис — ланцюжок запису лишається в календарі без наряду, інші записи наряду
   * позначаються видаленими, планові дати наряду стираються. Сама зміна запису (клієнт, час,
   * нотатки) — як раніше, `CalendarService.updateSlot`, у тій самій транзакції.
   *
   * Відв'язка — перев'язка «ні на що» (BR-WO-028): лише коли наряд у редагованому статусі
   * (BR-WO-027), інакше 400 — і до транзакції, і під блокуванням наряду (Bug #907). Багатоденний
   * запис (якір чи продовження) відв'язується весь: клієнт, авто, примітка й механік — для всього
   * ланцюжка без перебудови (`updateSlotChainDetails`); час чи підйомник разом із відв'язкою
   * ланцюжка не змінюються, як у будь-якого багатоденного запису без наряду (Bug #906).
   */
  private async unlinkCalendarSlot(
    orgId: string,
    slot: {
      id: string;
      workOrderId: string;
      parentSlotId: string | null;
      startAt: Date;
      endAt: Date;
      liftId: string | null;
      employeeId: string | null;
    },
    change: CalendarSlotEdit,
    userId?: string,
  ): Promise<CalendarSlotResponseDto> {
    const { workOrderId } = slot;
    const [wo, chain] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { status: true, branchId: true },
      }),
      this.slotChain(orgId, slot),
    ]);
    if (wo && !EDITABLE_STATUSES.includes(wo.status))
      throw new BadRequestException(
        translateError('err.calendar.workOrderRelinkLocked', getLocale()),
      );
    const hours = await this.calendar.resolveWorkHours(orgId, wo?.branchId ?? null);
    const chainIds = chain.map(s => s.id);
    let released: DatesReleased | null = null;
    const unlinkInTx = async (tx: Prisma.TransactionClient) => {
      // Наряд — перший у транзакції, до записів календаря (як `applyUpdate`: наряд → записи); статус
      // — ще раз під блокуванням: перехід «В роботу» поруч інакше втратив би дати (BR-WO-027).
      await lockWorkOrdersForUpdate(tx, orgId, [workOrderId]);
      const locked = await tx.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { status: true },
      });
      if (locked && !EDITABLE_STATUSES.includes(locked.status))
        throw new BadRequestException(
          translateError('err.calendar.workOrderRelinkLocked', getLocale()),
        );
      await tx.calendarSlot.updateMany({
        where: { orgId, id: { in: chainIds }, deletedAt: null },
        data: { workOrderId: null },
      });
      released = await this.releaseWorkOrderDates(tx, orgId, workOrderId, hours);
    };

    let res: CalendarSlotResponseDto;
    if (chain.length > 1) {
      // Час чи підйомник відв'язаного ланцюжка — правка багатоденного запису без наряду (400).
      if (movesWorkOrderSlot(slot, { ...change, workOrderId: undefined }))
        throw new BadRequestException(translateError('err.calendar.slotSplitTwoDays', getLocale()));
      const employeeId = change.employeeId !== undefined ? change.employeeId : slot.employeeId;
      const mechanicChanged = (employeeId ?? null) !== slot.employeeId;
      if (employeeId && mechanicChanged)
        await this.assertSlotMechanic(orgId, employeeId, slot.liftId);
      await this.calendar.updateSlotChainDetails(
        orgId,
        chain,
        {
          ...(mechanicChanged && { employeeId }),
          notes: change.notes,
          counterpartyId: change.counterpartyId,
          vehicleId: change.vehicleId,
        },
        { inTx: unlinkInTx },
      );
      const anchorId = slot.parentSlotId ?? slot.id;
      const anchor = await this.calendar.findSlotById(orgId, anchorId);
      if (!anchor)
        throw new NotFoundException(translateError('err.calendar.slotNotFound', getLocale()));
      res = anchor;
    } else {
      res = await this.calendar.updateSlot(orgId, slot.id, change, { inTx: unlinkInTx });
    }
    this.recordDatesReleased(orgId, workOrderId, userId, released);
    return res;
  }

  /**
   * BR-WO-026 у транзакції `tx`: живі записи наряду позначаються видаленими, планові початок і
   * завершення наряду стираються, а нормогодини — коли вони виведені з дат (дорівнюють робочим
   * годинам між ними, як рахує картка — Bug #903). Повертає старі й нові значення для журналу
   * змін наряду або `null`, якщо дат не було (чи наряд видалено).
   *
   * `editableOnly` — видалення запису (BR-WO-026): статус наряду перечитується під блокуванням і
   * не в редагованому статусі дає 400 до будь-якої зміни.
   */
  private async releaseWorkOrderDates(
    tx: Prisma.TransactionClient,
    orgId: string,
    workOrderId: string,
    hours: WorkHours,
    opts: { editableOnly?: boolean } = {},
  ): Promise<DatesReleased | null> {
    // Наряд блокується до записів календаря (порядок `applyUpdate`: наряд → записи), і його дати
    // та статус читаються під блокуванням: збереження наряду поруч не загубить нових дат.
    await lockWorkOrdersForUpdate(tx, orgId, [workOrderId]);
    const wo = await tx.workOrder.findFirst({
      where: { id: workOrderId, orgId, deletedAt: null },
      select: { plannedAt: true, dueDate: true, plannedHours: true, status: true },
    });
    if (wo && opts.editableOnly) assertSlotDeletable(wo.status);
    await this.calendar.removeWorkOrderSlots(tx, orgId, workOrderId, new Date());
    if (!wo || (wo.plannedAt === null && wo.dueDate === null)) return null;
    // Значення «до» — у локальні змінні до запису (таблиця в пам'яті спеків віддає сам рядок).
    const { plannedAt, dueDate, plannedHours } = wo;
    const derived =
      plannedHours !== null &&
      plannedAt !== null &&
      dueDate !== null &&
      Math.abs(workHoursBetween(plannedAt, dueDate, hours) - plannedHours) < 0.005;
    await tx.workOrder.updateMany({
      where: { id: workOrderId, orgId, deletedAt: null },
      data: { plannedAt: null, dueDate: null, ...(derived && { plannedHours: null }) },
    });
    return {
      old: { plannedAt, dueDate, ...(derived && { plannedHours }) },
      next: { plannedAt: null, dueDate: null, ...(derived && { plannedHours: null }) },
    };
  }

  /** Журнал змін наряду: дати стерто, бо наряд утратив запис календаря (BR-WO-026). */
  private recordDatesReleased(
    orgId: string,
    workOrderId: string,
    userId: string | undefined,
    released: DatesReleased | null,
  ): void {
    if (!userId || !released) return;
    this.audit
      .record(orgId, 'WorkOrder', workOrderId, 'UPDATE', userId, released.old, released.next)
      .catch((e: unknown) =>
        this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : e}`),
      );
  }

  /**
   * Тіло `update`: ще й причина зняття механіка з запису наряду (BR-CAL-012), коли підйомник
   * змінився, — її показує перетягування в календарі (`reschedule`).
   *
   * `opts` — зміна, що прийшла з запису календаря (BR-WO-024): `forceSlot` перебудовує запис
   * наряду, навіть коли дати й підйомник наряду ті самі (запис міг розійтися з нарядом раніше),
   * `slot` — механік і примітка для запису наряду з форми чи планшета, `inTx` — що ще зробити в
   * транзакції наряду перед його записом календаря (перев'язка запису, BR-WO-028).
   */
  private async applyUpdate(
    orgId: string,
    id: string,
    dto: UpdateWorkOrderDto,
    userId?: string,
    opts: {
      forceSlot?: boolean;
      slot?: { employeeId?: string | null; notes?: string | null };
      inTx?: (tx: Prisma.TransactionClient) => Promise<void>;
    } = {},
  ): Promise<{
    workOrder: WorkOrderResponseDto;
    mechanicDroppedReason: MechanicRejectReason | null;
  }> {
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
    // BR-WO-015: «сплачено» ведеться у валюті наряду — сплачений наряд валюту не змінює.
    const currencyChanging =
      dto.currencyId !== undefined && (dto.currencyId ?? null) !== wo.currencyId;
    if (currencyChanging && moneyFromDecimal(wo.paidAmount) > 0) {
      throw new BadRequestException(
        translateError('err.workOrder.paidCurrencyLocked', getLocale()),
      );
    }

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

    // BR-WO-019: перевіряються лише планові дати, що змінюються відносно збережених.
    const next: PlannedDates = {
      plannedAt: nextDate(dto.plannedAt, wo.plannedAt),
      dueDate: nextDate(dto.dueDate, wo.dueDate),
    };
    const hours = await this.assertPlannedDates(orgId, wo.branchId, next, wo);
    // BR-WO-020: запис календаря наряду переноситься, коли змінились дати чи підйомник, і
    // позначається видаленим, коли наряд мав обидві дати, а тепер — ні. Форма шле дати й
    // підйомник щоразу, тож порівнюється зі збереженим, а не «поле є в запиті».
    const nextLiftId = dto.liftId === undefined ? wo.liftId : (dto.liftId ?? null);
    const datesChanged =
      !sameInstant(next.plannedAt, wo.plannedAt) || !sameInstant(next.dueDate, wo.dueDate);
    const { plannedAt, dueDate } = next;
    const slotAction: 'upsert' | 'remove' | null =
      plannedAt && dueDate
        ? datesChanged || nextLiftId !== wo.liftId || opts.forceSlot
          ? 'upsert'
          : null
        : wo.plannedAt && wo.dueDate
          ? 'remove'
          : null;

    const updateWo = (db: Prisma.TransactionClient) =>
      db.workOrder.update({
        // BR-WO-015: умова «нічого не сплачено» — у самому записі зміни валюти: оплата, що прийшла
        // між читанням і записом, інакше лишила б «сплачено» в одній валюті, а наряд — в іншій.
        where: { id, orgId, ...(currencyChanging && { paidAmount: 0 }) },
        data: {
          description: dto.description,
          inMileage: dto.inMileage,
          outMileage: dto.outMileage,
          priority: dto.priority,
          repairCategory: dto.repairCategory,
          clientApproval: dto.clientApproval,
          // Distinguish "field omitted" (undefined → skip) from "field cleared"
          // (null → set NULL). `dto.plannedAt === null` writes NULL.
          plannedAt: dto.plannedAt === undefined ? undefined : next.plannedAt,
          dueDate: dto.dueDate === undefined ? undefined : next.dueDate,
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
        include: WO_WRITE_INCLUDE,
      });

    let mechanicDroppedReason: MechanicRejectReason | null = null;
    const persist =
      slotAction === null && !opts.inTx
        ? updateWo(this.prisma)
        : this.prisma.$transaction(
            async tx => {
              await opts.inTx?.(tx);
              const res = await updateWo(tx);
              if (slotAction === 'remove') {
                await this.calendar.removeWorkOrderSlots(tx, orgId, id);
              } else if (slotAction === 'upsert') {
                ({ mechanicDroppedReason } = await this.calendar.upsertWorkOrderSlot(tx, {
                  orgId,
                  workOrderId: id,
                  branchId: wo.branchId,
                  liftId: nextLiftId,
                  startAt: plannedAt!,
                  endAt: dueDate!,
                  vehicleId: wo.vehicleId,
                  counterpartyId: wo.counterpartyId,
                  ...(hours && { hours }),
                  ...opts.slot,
                }));
              }
              return res;
            },
            { timeout: TRANSACTION_TIMEOUT_MS },
          );
    const updated = await persist.catch((e: unknown) => {
      if (currencyChanging && (e as { code?: string } | null)?.code === 'P2025') {
        throw new BadRequestException(
          translateError('err.workOrder.paidCurrencyLocked', getLocale()),
        );
      }
      if (slotAction !== null || opts.inTx)
        throwIfExclusionConflict(e, CALENDAR_SLOT_EXCLUSION, slotRaceMessage());
      throw e;
    });

    // AuditEvent for field-level updates (only if something actually changed)
    if (userId && Object.keys(newData).length > 0) {
      this.audit
        .record(orgId, 'WorkOrder', id, 'UPDATE', userId, oldData, newData)
        .catch((e: unknown) =>
          this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : e}`),
        );
    }

    return { workOrder: this.toDto(updated), mechanicDroppedReason };
  }

  async remove(orgId: string, id: string, userId?: string): Promise<void> {
    // Narrow tenant guard — потрібен лише `status` + `number` (для audit log).
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true, number: true, paidAmount: true },
    });
    if (!wo) throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));
    if (!DELETABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException(
        translateError('err.workOrder.onlyDraftOrCancelledDeletable', getLocale()),
      );
    }
    this.assertNotPaid(wo.paidAmount, 'err.workOrder.paidCannotDelete');
    // Race-safe updateMany з повним compound where (id+orgId+deletedAt:null). BR-WO-014: умова
    // «нічого не сплачено» — у самому записі, тож оплата між читанням і видаленням не проскочить.
    // BR-WO-017: у тій самій транзакції — записи календаря наряду (обидві частини багатоденного):
    // підйомник і механік звільняються, запис у календарі не показується.
    const deletedAt = new Date();
    const removed = await this.prisma.$transaction(
      async tx => {
        const res = await tx.workOrder.updateMany({
          where: { id, orgId, deletedAt: null, status: wo.status, paidAmount: 0 },
          data: { deletedAt },
        });
        if (res.count === 0) return res;
        await this.calendar.removeWorkOrderSlots(tx, orgId, id, deletedAt);
        // BR-WO-021: чернетка могла тримати резерв отриманого від постачальника (BR-PL-011).
        await this.stockEffects.releaseAllNetReservations(orgId, id, userId, tx);
        return res;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    if (removed.count === 0) {
      throw await this.paidOrChangedError(orgId, id, 'err.workOrder.paidCannotDelete');
    }
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
            // Планові дати не копіюються: клон — новий візит, дати оригіналу здебільшого вже минули
            // (BR-WO-019), а запис календаря (BR-WO-020) клон отримає, щойно йому призначать
            // початок і завершення. Нормогодини копіюються — це обсяг робіт, не час.
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
    // в цій функції: reserveParts/releaseAllNetReservations/writeOffPartsAndCharge всі
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
        paidAmount: true,
      },
    });
    if (!wo) throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));

    assertFsmTransition(WORK_ORDER_TRANSITIONS, wo.status, newStatus);

    // BR-WO-014: сплачений наряд не скасовується — спершу сторно оплати. Тут — швидка відмова;
    // авторитетна умова `paidAmount: 0` стоїть у CAS нижче.
    if (newStatus === 'CANCELLED')
      this.assertNotPaid(wo.paidAmount, 'err.workOrder.paidCannotCancel');
    // BR-WO-016: «Оплачено» — лише за грошима. Ручний перехід дозволено лише повністю сплаченому
    // наряду; CAS нижче тримає прочитані суми, тож сторно між перевіркою і записом не проскочить.
    if (newStatus === 'PAID' && !isWorkOrderFullyPaid(wo.totalAmount, wo.paidAmount)) {
      throw new BadRequestException(
        translateError('err.workOrder.paidRequiresFullPayment', getLocale(), {
          remaining: money(
            moneyFromDecimal(wo.totalAmount) - moneyFromDecimal(wo.paidAmount),
          ).toFixed(2),
        }),
      );
    }

    const updates: { status: WorkOrderStatus; completedAt?: Date } = { status: newStatus };
    if (newStatus === 'COMPLETED') updates.completedAt = new Date();
    // Авто-кроки до «Оплачено» (BR-WO-016), зроблені в транзакції, — події для них після коміту.
    let settleSteps: WorkOrderStatusStep[] = [];

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
        // BR-WO-014: скасування — лише без оплати (`paidAmount: 0` у тому самому CAS). BR-WO-016:
        // ручне «Оплачено» — на тих сумах, що перевірено вище.
        const cas = await tx.workOrder.updateMany({
          where: {
            id,
            orgId,
            deletedAt: null,
            status: wo.status,
            ...(newStatus === 'CANCELLED' && { paidAmount: 0 }),
            ...(newStatus === 'PAID' && {
              paidAmount: wo.paidAmount,
              totalAmount: wo.totalAmount,
            }),
          },
          data: updates,
        });
        if (cas.count === 0) {
          throw newStatus === 'CANCELLED'
            ? await this.paidOrChangedError(orgId, id, 'err.workOrder.paidCannotCancel', tx)
            : new BadRequestException(translateError('err.workOrder.statusChanged', getLocale()));
        }

        // BR-WO-022: скасування з будь-якого статусу (зокрема з «Виконано») позначає видаленими
        // всі записи календаря наряду — якір і продовження; підйомник і механік звільняються.
        // Після CAS наряду — той самий порядок блокувань «наряд → записи», що в update/remove.
        if (newStatus === 'CANCELLED') {
          await this.calendar.removeWorkOrderSlots(tx, orgId, id);
        }

        // BR-WO-021: кожен вхід у «В роботі» дорезервовує лише бракуюче (потрібно − net-резерв,
        // не більше available) — повторний вхід з «Призупинено» резерву не подвоює (WO-C1), а
        // нестача перехід не блокує.
        if (newStatus === 'IN_PROGRESS') {
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

        // BR-WO-021: скасування з будь-якого статусу, крім COMPLETED (там резерв знято списанням),
        // знімає весь net-резерв наряду — він міг з'явитись і до «В роботі» (приймання, BR-PL-011).
        if (newStatus === 'CANCELLED' && wo.status !== 'COMPLETED') {
          await this.stockEffects.releaseAllNetReservations(orgId, id, userId, tx);
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

        // BR-WO-016: наряд, сплачений авансом повністю, з «Виконано» чи «Виставлено» сам іде далі
        // до «Оплачено» — у цій самій транзакції. BR-PAY-022: борг щойно нараховано, тож для
        // іноземної валюти — курсова різниця (якщо наряд сплачено повністю).
        if (newStatus === 'COMPLETED' || newStatus === 'INVOICED') {
          settleSteps = await settleIfFullyPaidInTx(tx, orgId, id);
          // Кроки є лише тоді, коли наряд сплачено повністю, — інакше курсової різниці ще немає.
          if (newStatus === 'COMPLETED' && settleSteps.length > 0) {
            await this.stockEffects.postFxIfSettled(orgId, id, userId, tx);
          }
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
    this.emitStatusSteps(orgId, id, settleSteps, userId);

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

  /**
   * Події TRANSITIONED для кроків, зроблених у чужій транзакції (`settleIfFullyPaidInTx`: оплата,
   * підписання акта). Викликати ПІСЛЯ коміту — як і для звичайного переходу.
   */
  emitStatusSteps(
    orgId: string,
    workOrderId: string,
    steps: readonly WorkOrderStatusStep[],
    userId?: string,
  ): void {
    for (const step of steps) {
      this.events.emit(
        WORK_ORDER_EVENTS.TRANSITIONED,
        new WorkOrderTransitionedEvent(orgId, workOrderId, step.from, step.to, userId),
      );
    }
  }

  /** BR-WO-014: наряд зі сплаченим > 0 не скасувати й не видалити — спершу сторно оплати. */
  private assertNotPaid(paidAmount: Prisma.Decimal | number, key: PaidGuardKey): void {
    const error = paidError(paidAmount, key);
    if (error) throw error;
  }

  /**
   * CAS із умовою «нічого не сплачено» не пройшов: перечитуємо наряд і повертаємо точну причину —
   * оплата, що з'явилась між читанням і записом (BR-WO-014), зниклий наряд або змінений статус.
   */
  private async paidOrChangedError(
    orgId: string,
    id: string,
    key: PaidGuardKey,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<BadRequestException | NotFoundException> {
    const now = await db.workOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { paidAmount: true },
    });
    if (!now) return new NotFoundException(translateError('err.workOrder.notFound', getLocale()));
    return (
      paidError(now.paidAmount, key) ??
      new BadRequestException(translateError('err.workOrder.statusChanged', getLocale()))
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
    const amount = lineAmount(normoHours, price);

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
    // sto-optimize: wo narrow {status}; line narrow — defaults (normoHours, price) і чинні
    // workId / employeeId, щоб відрізнити зміну від повторної відправки того самого значення.
    const [wo, line] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { status: true },
      }),
      this.prisma.workOrderLine.findFirst({
        where: { id: lineId, workOrderId, orgId, deletedAt: null },
        select: { normoHours: true, price: true, workId: true, employeeId: true },
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

    // BR-WO-011: нова робота / новий виконавець рядка мають існувати в організації (як у addLine).
    // Раніше workId / employeeId приймались у DTO, але не писались: картка наряду показувала
    // нового виконавця, відповідь була 200, а в базі лишався старий (Bug #836).
    // Перевіряємо лише ЗМІНЕНЕ значення: картка шле роботу й виконавця кожного рядка при кожному
    // збереженні, і рядок із уже видаленою роботою чи звільненим виконавцем має зберігатись далі.
    const newWorkId = dto.workId && dto.workId !== line.workId ? dto.workId : undefined;
    const newEmployeeId =
      dto.employeeId && dto.employeeId !== line.employeeId ? dto.employeeId : undefined;
    const [work, employee] = await Promise.all([
      newWorkId
        ? this.prisma.work.findFirst({
            where: { id: newWorkId, orgId, deletedAt: null },
            select: { id: true },
          })
        : null,
      newEmployeeId
        ? this.prisma.employee.findFirst({
            where: { id: newEmployeeId, orgId, deletedAt: null },
            select: { id: true },
          })
        : null,
    ]);
    if (newWorkId && !work)
      throw new NotFoundException(translateError('err.workOrder.workNotFound', getLocale()));
    if (newEmployeeId && !employee)
      throw new NotFoundException(translateError('err.workOrder.employeeNotFound', getLocale()));

    const normoHours = dto.normoHours ?? line.normoHours;
    const price = dto.price !== undefined ? money(dto.price) : moneyFromDecimal(line.price);
    const amount = lineAmount(normoHours, price);

    const updated = await this.prisma.$transaction(
      async tx => {
        const result = await tx.workOrderLine.update({
          where: { id: lineId, orgId },
          data: {
            // undefined → Prisma поле не чіпає (часткова правка лишає роботу й виконавця як були).
            workId: newWorkId,
            employeeId: newEmployeeId,
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
    const amount = lineAmount(dto.quantity, price);

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
    const amount = lineAmount(quantity, price);

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
        // Порядок блокувань «наряд → склад» (як у transition і прийманні, BR-PL-011): потреба
        // наряду не змінюється, поки приймання резервує під нього.
        await lockWorkOrdersForUpdate(tx, orgId, [workOrderId]);
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
        // BR-WO-021: менша кількість чи інша одиниця — надлишок резерву знімається.
        await this.stockEffects.reconcileAfterPartsChange(orgId, workOrderId, undefined, tx);
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
        await lockWorkOrdersForUpdate(tx, orgId, [workOrderId]);
        await tx.workOrderPart.update({
          where: { id: partId, orgId },
          data: { deletedAt: new Date() },
        });
        await this.recalcTotals(workOrderId, tx, orgId);
        // BR-WO-021: резерв за прибраним рядком знімається.
        await this.stockEffects.reconcileAfterPartsChange(orgId, workOrderId, undefined, tx);
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

  /**
   * Друкований наряд-замовлення (BR-WO-013): лише від «Виконано» (`WO_INVOICE_VISIBLE_STATUSES`) —
   * до того клієнт отримує кошторис; дата — дата документа наряду; шапка — реквізити й логотип
   * організації. Видалений наряд → 404 (BR-WO-012).
   */
  async generatePdf(orgId: string, id: string): Promise<Buffer> {
    const [wo, org] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id, orgId, deletedAt: null },
        // PDF select narrow: тягнемо лише поля що рендеряться у docDef.
        // Раніше include тягнув orgId/branchId/sortOrder/costPrice/description (lines/parts) + unit/coefficient (good)
        // які не використовуються у PDF — лише name/quantity/price/amount + work.name + good.name.
        select: {
          number: true,
          status: true,
          documentDate: true,
          inMileage: true,
          totalNet: true,
          totalAmount: true,
          // Валюта наряду — біля сум друкованого документа (Bug #865).
          currency: { select: { code: true } },
          vehicle: { select: { make: true, model: true, licensePlate: true, vin: true } },
          counterparty: {
            select: { firstName: true, lastName: true, companyName: true, phone: true },
          },
          // Рядки друкованого наряду — у порядку введення, як на екрані, в акті й кошторисі. Без
          // orderBy Postgres віддавав їх довільно: три однакові наряди друкувались трьома
          // різними порядками рядків (Bug #814).
          lines: {
            where: { deletedAt: null },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: 500,
            select: {
              quantity: true,
              price: true,
              amount: true,
              // Одиниця рядка: обрана в рядку, інакше базова одиниця товару.
              unitOfMeasure: { select: { shortName: true } },
              good: {
                select: {
                  name: true,
                  unit: true,
                  unitOfMeasure: { select: { shortName: true } },
                },
              },
            },
          },
        },
      }),
      this.orgPrintInfo.get(orgId),
    ]);
    if (!wo) throw new NotFoundException(translateError('err.workOrder.notFound', getLocale()));
    if (!WO_INVOICE_VISIBLE_STATUSES.includes(wo.status))
      throw new BadRequestException(
        translateError('err.workOrder.printBeforeCompletion', getLocale()),
      );

    const cp = wo.counterparty;
    const counterpartyName = formatPersonName(cp?.lastName, cp?.firstName, cp?.companyName) || '';
    const vehicleLabel = formatVehicleLabel(wo.vehicle);

    return this.pdf.generateWorkOrderPdf({
      org,
      counterparty: { name: counterpartyName, phone: cp?.phone },
      vehicleLabel,
      vin: wo.vehicle?.vin,
      mileage: wo.inMileage,
      currencyCode: wo.currency?.code,
      number: wo.number,
      date: wo.documentDate,
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
          normoHours: l.normoHours,
          actualHours: l.actualHours,
          price,
          total: lineAmount(quantity, price),
        };
      }),
      parts: wo.parts.map(p => ({
        name: p.good?.name ?? '',
        quantity: p.quantity,
        unit:
          p.unitOfMeasure?.shortName ?? p.good?.unitOfMeasure?.shortName ?? p.good?.unit ?? 'шт',
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
    const [invoices, payments, calendarSlots, warranties, listItems] = await Promise.all([
      this.prisma.invoice.findMany({
        // CANCELLED invoices excluded for consistency with `findByWorkOrder` and
        // `createFromWorkOrder` pre-check: the "Документи" badge must not count cancelled
        // invoices — otherwise the user sees count > 0 but no active invoice exists.
        where: { workOrderId, orgId, deletedAt: null, status: { not: InvoiceStatus.CANCELLED } },
        select: { id: true, number: true, status: true, amount: true, documentDate: true },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
      // Сторновані оплати показуємо з позначкою `reversedAt` (BR-CASH-024), не ховаємо.
      this.prisma.payment.findMany({
        where: { workOrderId, orgId },
        select: {
          id: true,
          amount: true,
          method: true,
          createdAt: true,
          notes: true,
          fiscalStatus: true,
          reversedAt: true,
        },
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
      // Списки купівлі з позиціями наряду (docs/objects/purchase-list.md).
      this.prisma.purchaseListItem.findMany({
        where: { workOrderId, orgId, deletedAt: null, list: { deletedAt: null } },
        select: { list: { select: { id: true, number: true, status: true, createdAt: true } } },
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
      purchaseLists: Array.from(new Map(listItems.map(i => [i.list.id, i.list])).values()),
    };
  }

  async getLinkedCounts(orgId: string, workOrderIds: string[]) {
    if (!workOrderIds.length) return {};

    const [invoices, payments, calendarSlots, warranties, listItems] = await Promise.all([
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
      // Різні списки купівлі з позиціями наряду: пара (наряд, список) — одна група.
      this.prisma.purchaseListItem.groupBy({
        by: ['workOrderId', 'listId'],
        where: {
          workOrderId: { in: workOrderIds },
          orgId,
          deletedAt: null,
          list: { deletedAt: null },
        },
      }),
    ]);

    const result: Record<
      string,
      {
        invoices: number;
        payments: number;
        calendarSlots: number;
        warranties: number;
        purchaseLists: number;
      }
    > = {};
    for (const id of workOrderIds) {
      result[id] = { invoices: 0, payments: 0, calendarSlots: 0, warranties: 0, purchaseLists: 0 };
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
    listItems.forEach(r => {
      if (r.workOrderId && result[r.workOrderId]) result[r.workOrderId].purchaseLists += 1;
    });
    return result;
  }
}
