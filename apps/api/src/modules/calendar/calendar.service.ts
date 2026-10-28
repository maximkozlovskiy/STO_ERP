import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import {
  CalendarSlotStatus,
  CalendarSlotType,
  EmployeeStatus,
  Prisma,
  WorkOrderStatus,
} from '@prisma/client';
import { DEFAULT_WORK_HOURS, formatPersonName, TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { err } from '../../common/utils/err';
import { throwIfExclusionConflict } from '../../common/utils/prisma-errors';
import {
  addDaysKyiv,
  isCalendarDate,
  kyivDayEnd,
  kyivDayStart,
  kyivYmd,
} from '../../common/utils/kyiv-date';
import {
  kyivHourOnDay,
  splitByWorkHours,
  workHoursOf,
  type TimeSegment,
  type WorkHours,
} from '../../common/utils/work-hours';
import {
  CreateCalendarSlotDto,
  CalendarSlotResponseDto,
  CreateCalendarSlotResponseDto,
  CheckConflictsDto,
  CheckConflictsResponseDto,
  type CalendarSlotEdit,
} from './calendar.dto';
import {
  findMechanicOnLift,
  MECHANIC_REJECT_KEY,
  type MechanicRejectReason,
} from './calendar-mechanic';
import { assertServiceSlotUnlinked } from './calendar-slot-type';

/** Новий запис календаря без наряду (`createSlot`): запис наряду створює наряд (BR-WO-028). */
export type FreeSlotInput = Omit<CreateCalendarSlotDto, 'workOrderId'> & { workOrderId?: never };

/**
 * EXCLUDE-обмеження БД проти перетину записів на підйомнику — запасний захист від паралельного
 * бронювання (CAL-C1). Його ім'я шукає `throwIfExclusionConflict` тут і в нарядах (BR-WO-020).
 */
export const CALENDAR_SLOT_EXCLUSION = 'calendar_slots_no_overlap';
/** Те саме для механіка: два живі записи одного механіка не перетинаються (BR-CAL-006). */
export const CALENDAR_SLOT_MECHANIC_EXCLUSION = 'calendar_slots_mechanic_no_overlap';

/**
 * Текст 409 за назвою порушеного EXCLUDE — тим самим перекладом, що й 400 проби зайнятості.
 * Підйомник — першим: 23P01 без назви констрейнта звучить, як і до механічного EXCLUDE.
 */
export const slotExclusionMessages = (): Record<string, string> => ({
  [CALENDAR_SLOT_EXCLUSION]: err('err.calendar.liftBusy'),
  [CALENDAR_SLOT_MECHANIC_EXCLUSION]: err('err.calendar.employeeBusy'),
});

// sto-optimize (cycle 3/3): shared include shape для create()/update() — попереджає alloc per-request.
// Дзеркалить SLOT_INCLUDE що раніше жив у тілі create(). Прив'язан до Prisma Client через inference.
const SLOT_INCLUDE = {
  counterparty: {
    select: { firstName: true, lastName: true, companyName: true, phone: true } as const,
  },
  vehicle: { select: { make: true, model: true, licensePlate: true } as const },
  workOrder: {
    select: {
      number: true,
      status: true,
      deletedAt: true,
      counterpartyId: true,
      counterparty: {
        select: { firstName: true, lastName: true, companyName: true, phone: true } as const,
      },
      vehicle: { select: { make: true, model: true, licensePlate: true } as const },
    },
  },
} as const;

// sto-optimize (cycle 3/3): CONFLICT_SELECT hoisted from checkConflicts() body.
// Security: strip PII — conflict check only needs scheduling fields + WO number.
// MECHANIC role has access to this endpoint; returning cpPhone/vehiclePlate would
// allow enumeration of all customer PII across the org.
// Defense-in-depth: counterpartyId also dropped — no consumer uses it, and exposing
// it would let MECHANIC enumerate customer UUIDs via time-window probing.
const CONFLICT_SELECT = {
  id: true,
  startAt: true,
  endAt: true,
  liftId: true,
  employeeId: true,
  workOrderId: true,
  parentSlotId: true,
  status: true,
  type: true,
  workOrder: {
    select: { number: true, status: true, deletedAt: true },
  },
} as const;

/**
 * Запис без наряду або наряду, що не видалений і не скасований (BR-CAL-011, BR-WO-017,
 * BR-WO-022). Видалення й скасування наряду самі позначають видаленими його записи; ця умова — на
 * випадок записів, які це пережили (дані до міграції
 * `20261016120000_calendar_slots_of_deleted_work_orders` і записи нарядів, скасованих до
 * 2026-10-18): їх не показує `findSlots` і не бачить перевірка зайнятості. `OR` — у `AND`, бо
 * проби вже мають власний `OR`. `is` не пропускає запис без наряду, тому `workOrderId: null` —
 * окремою гілкою.
 */
const OF_LIVE_WORK_ORDER = {
  OR: [
    { workOrderId: null },
    { workOrder: { is: { deletedAt: null, status: { not: WorkOrderStatus.CANCELLED } } } },
  ],
};

/**
 * Записи, що не належать наряду `workOrderId`, разом із записами без наряду: Prisma `{ not: X }`
 * дає SQL `<> X`, що відкидає й NULL, — і звичайне бронювання підйомника не було б конфліктом
 * (BR-WO-020, review 2026-10-16).
 */
const notOfWorkOrder = (workOrderId: string) => ({
  OR: [{ workOrderId: null }, { workOrderId: { not: workOrderId } }],
});

/**
 * Зайнятість ресурсу (BR-CAL-005): живі записи організації на `resource` (підйомник, механік чи
 * `OR` обох), що перетинають хоч один із проміжків `intervals` — half-open, дотик меж не є
 * перетином. Записи видаленого наряду не рахуються (BR-CAL-011). Не конфлікт: `exclude.ids` — сам
 * запис чи власні записи наряду; `exclude.workOrderId` — усі записи наряду.
 */
function busyWhere(
  orgId: string,
  resource: Prisma.CalendarSlotWhereInput,
  intervals: readonly TimeSegment[],
  exclude: { ids?: readonly string[] | undefined; workOrderId?: string | undefined } = {},
): Prisma.CalendarSlotWhereInput {
  return {
    orgId,
    ...resource,
    deletedAt: null,
    ...(exclude.ids?.length ? { NOT: { id: { in: [...exclude.ids] } } } : {}),
    AND: [
      OF_LIVE_WORK_ORDER,
      ...(exclude.workOrderId ? [notOfWorkOrder(exclude.workOrderId)] : []),
      { OR: intervals.map(i => ({ startAt: { lt: i.endAt }, endAt: { gt: i.startAt } })) },
    ],
  };
}

/**
 * Ім'я механіка запису з уже прочитаних (BR-CAL-011): `null` — механіка не призначено, його
 * немає в організації або він звільнений.
 */
function nameOf(employeeId: string | null, names: ReadonlyMap<string, string>): string | null {
  return employeeId ? names.get(employeeId) || null : null;
}

/** Стеля записів на добу у видачі (як було для запиту одного дня). */
const DAY_SLOTS_TAKE = 500;
/** Найдовший діапазон `from..to`, діб: квартал «Статистики» (`STATS_MAX_DAYS` вебу) з запасом. */
const RANGE_MAX_DAYS = 93;

@Injectable()
export class CalendarService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * §13 config-over-hardcode: межі робочого дня філії з BranchSettings
   * (workStartTime/workEndTime "HH:mm"). Типові години (`DEFAULT_WORK_HOURS`, 09–18 — ті самі,
   * що в `GET /settings/work-hours`), коли:
   *  - філію не визначено (запис без підйомника),
   *  - BranchSettings ще не створені для філії,
   *  - workEndTime ≤ workStartTime чи невалідний час (некоректна конфігурація),
   *  - будь-яка помилка читання (офлайн-стійкість).
   * Ці ж години перевіряють планові дати наряду (BR-WO-019).
   */
  async resolveWorkHours(orgId: string, branchId: string | null): Promise<WorkHours> {
    if (!branchId) return DEFAULT_WORK_HOURS;
    try {
      const bs = await this.prisma.branchSettings.findFirst({
        where: { branchId, orgId },
        select: { workStartTime: true, workEndTime: true },
      });
      return workHoursOf(bs);
    } catch {
      return DEFAULT_WORK_HOURS;
    }
  }

  async findSlots(
    orgId: string,
    date: string,
    role: string,
    branchId?: string,
    employeeId?: string,
  ): Promise<CalendarSlotResponseDto[]> {
    if (!date || !isCalendarDate(date))
      throw new BadRequestException(err('err.calendar.invalidDateFormatExpected'));
    // Межі київської доби. Раніше обидві рахувались зсувом ПОЛУДНЯ: у день переведення
    // годинника (29.03, 25.10) північ мала інший зсув, і початок дня з'їжджав на годину.
    return this.querySlots(
      orgId,
      kyivDayStart(date),
      kyivDayEnd(date),
      DAY_SLOTS_TAKE,
      role,
      branchId,
      employeeId,
    );
  }

  /**
   * Записи, що перетинають київські доби `from..to` включно, — ОДНИМ запитом. «Місяць» і
   * «Статистика» раніше слали запит на кожен день (32 за відкриття місяця) і впирались у ліміт
   * 200 запитів/хв (429, порожні дні без жодного знаку). Розкладає по днях клієнт.
   */
  async findSlotsInRange(
    orgId: string,
    from: string,
    to: string,
    role: string,
    branchId?: string,
    employeeId?: string,
  ): Promise<CalendarSlotResponseDto[]> {
    if (!isCalendarDate(from) || !isCalendarDate(to) || from > to)
      throw new BadRequestException(err('err.calendar.invalidDateFormatExpected'));
    const start = kyivDayStart(from);
    const end = kyivDayEnd(to);
    // Доби різної довжини (перехід годинника) — округлення до цілих діб.
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    if (days > RANGE_MAX_DAYS)
      throw new BadRequestException(err('err.calendar.rangeTooLong', { max: RANGE_MAX_DAYS }));
    return this.querySlots(orgId, start, end, DAY_SLOTS_TAKE * days, role, branchId, employeeId);
  }

  private async querySlots(
    orgId: string,
    start: Date,
    end: Date,
    take: number,
    role: string,
    branchId?: string,
    employeeId?: string,
  ): Promise<CalendarSlotResponseDto[]> {
    // CAL-C2: half-open OVERLAP, not CONTAINMENT. Containment (`startAt>=start AND endAt<=end`)
    // silently DROPS slots that cross the day boundary: a split-day continuation that starts the
    // previous evening, or any slot straddling midnight, is invisible in the day view → the calendar
    // shows a free lift that is actually occupied. Mirror the app-overlap probe used by checkConflicts()
    // and createSlot(): a slot intersects [start, end) iff `startAt < end AND endAt > start`.
    const where: {
      orgId: string;
      deletedAt: null;
      startAt: { lt: Date };
      endAt: { gt: Date };
      AND: (typeof OF_LIVE_WORK_ORDER)[];
      lift?: { zone: { branchId: string; orgId: string } };
      employeeId?: string;
    } = {
      orgId,
      deletedAt: null,
      startAt: { lt: end },
      endAt: { gt: start },
      // BR-CAL-011: записи видаленого наряду не показуються ніде в календарі.
      AND: [OF_LIVE_WORK_ORDER],
    };
    if (branchId) where.lift = { zone: { branchId, orgId } };
    if (employeeId) where.employeeId = employeeId;

    const isMechanic = role === 'MECHANIC';

    if (isMechanic) {
      // MECHANIC sees scheduling fields + WO number only — no customer PII.
      // counterpartyId deliberately NOT selected: it gets dropped by toConflictDto()
      // anyway, and exposing it would let MECHANIC enumerate customer UUIDs via
      // time-window probing (defense-in-depth, same rationale as checkConflicts).
      const slots = await this.prisma.calendarSlot.findMany({
        where,
        orderBy: { startAt: 'asc' },
        select: {
          id: true,
          startAt: true,
          endAt: true,
          liftId: true,
          employeeId: true,
          workOrderId: true,
          parentSlotId: true,
          status: true,
          type: true,
          workOrder: { select: { number: true, status: true, deletedAt: true } },
        },
        take,
      });
      // Ім'я механіка — не PII клієнта: механік бачить, хто на якому записі (BR-CAL-011).
      const names = await this.employeeNames(orgId, slots);
      return slots.map(s =>
        this.toConflictDto({ ...s, employeeName: nameOf(s.employeeId, names) }),
      );
    }

    const slots = await this.prisma.calendarSlot.findMany({
      where,
      orderBy: { startAt: 'asc' },
      include: SLOT_INCLUDE,
      take,
    });

    const names = await this.employeeNames(orgId, slots);
    return slots.map(item => this.toDto({ ...item, employeeName: nameOf(item.employeeId, names) }));
  }

  /**
   * «Прізвище Ім'я» механіків записів — ОДНИМ запитом на всю відповідь, не на кожен запис
   * (BR-CAL-011). `include` неможливий: у `CalendarSlot` немає зв'язку з `Employee`, лише
   * колонка `employeeId`. Звільнений (`FIRED`) чи видалений механік не показується —
   * `employeeName = null` (рішення власника 2026-10-16).
   */
  private async employeeNames(
    orgId: string,
    slots: readonly { employeeId: string | null }[],
  ): Promise<ReadonlyMap<string, string>> {
    const ids = [...new Set(slots.flatMap(s => (s.employeeId ? [s.employeeId] : [])))];
    if (ids.length === 0) return new Map();
    const employees = await this.prisma.employee.findMany({
      where: { orgId, id: { in: ids }, deletedAt: null, status: { not: EmployeeStatus.FIRED } },
      select: { id: true, firstName: true, lastName: true },
      take: ids.length,
    });
    return new Map(employees.map(e => [e.id, formatPersonName(e.lastName, e.firstName)]));
  }

  /**
   * Новий запис без наряду. Запис НАРЯДУ створює наряд (`WorkOrdersService.createCalendarSlot`,
   * BR-WO-028), тож `workOrderId` сюди не передається — це тримає тип `FreeSlotInput`.
   */
  async createSlot(orgId: string, dto: FreeSlotInput): Promise<CreateCalendarSlotResponseDto> {
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);

    if (endAt <= startAt) throw new BadRequestException(err('err.calendar.endBeforeStart'));
    assertServiceSlotUnlinked(dto.type, dto);

    // Validate FK ownership to prevent cross-tenant injection — independent checks run in parallel.
    // Narrow projection — потрібне лише існування (NotFoundException), не дані.
    const [lift, mechanic, counterparty, vehicle] = await Promise.all([
      dto.liftId
        ? this.prisma.lift.findFirst({
            where: { id: dto.liftId, orgId, deletedAt: null },
            // §13: тягнемо branchId через zone щоб резолвнути робочі години філії
            // (BranchSettings) для day-split. Дешево — id + один FK-hop.
            select: { id: true, zone: { select: { branchId: true } } },
          })
        : Promise.resolve(null),
      // BR-CAL-012: механік закріплений за підйомником запису — і для продовження багатоденного,
      // бо воно отримує той самий підйомник і механіка.
      dto.employeeId
        ? findMechanicOnLift(this.prisma, orgId, dto.employeeId, dto.liftId ?? null)
        : Promise.resolve(null),
      dto.counterpartyId
        ? this.prisma.counterparty.findFirst({
            where: { id: dto.counterpartyId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.vehicleId
        ? this.prisma.vehicle.findFirst({
            where: { id: dto.vehicleId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (dto.liftId && !lift) throw new NotFoundException(err('err.lift.notFound'));
    if (mechanic && !mechanic.ok)
      throw new BadRequestException(err(MECHANIC_REJECT_KEY[mechanic.reason]));
    if (dto.counterpartyId && !counterparty)
      throw new NotFoundException(err('err.calendar.clientNotFound'));
    if (dto.vehicleId && !vehicle) throw new NotFoundException(err('err.calendar.vehicleNotFound'));

    // §13: межі робочого дня per-branch (BranchSettings.workStartTime/workEndTime).
    // Резолвимо філію через lift.zone.branchId; без підйомника → типові години.
    const { startHour, endHour } = await this.resolveWorkHours(orgId, lift?.zone?.branchId ?? null);

    // Determine if slot overflows the working day end (endHour Kyiv, per-branch)
    const workDayEnd = kyivHourOnDay(kyivYmd(startAt), endHour);
    // Bug #819: split only a slot that STARTS inside the working day. For a slot that starts at or
    // after its end (23:30) the "today" part ended before it began: the parent was stored with
    // endAt < startAt, and the continuation got the whole gap since the end of the working day.
    // Such a slot is stored as requested - the same way as one that starts before opening (00:30).
    const isSplit = startAt < workDayEnd && endAt > workDayEnd;

    const slot1End = isSplit ? workDayEnd : endAt;
    const slot2Start = isSplit ? kyivHourOnDay(kyivYmd(addDaysKyiv(startAt, 1)), startHour) : null;
    const slot2End = isSplit
      ? new Date(slot2Start!.getTime() + (endAt.getTime() - workDayEnd.getTime()))
      : null;

    // SLOT_INCLUDE hoisted to module-level (sto-optimize cycle 3/3).

    let slots;
    try {
      slots = await this.prisma.$transaction(
        async tx => {
          // Conflict check for slot1 interval (+ slot2 interval if split) — all in parallel.
          const day1 = [{ startAt, endAt: slot1End }];
          const day2 = isSplit ? [{ startAt: slot2Start!, endAt: slot2End! }] : null;
          const busy = (resource: Prisma.CalendarSlotWhereInput, intervals: TimeSegment[]) =>
            tx.calendarSlot.findFirst({
              where: busyWhere(orgId, resource, intervals),
              select: { id: true },
            });
          const lift = dto.liftId ? { liftId: dto.liftId } : null;
          const employee = dto.employeeId ? { employeeId: dto.employeeId } : null;
          const [conflict1, empConflict1, conflict2, empConflict2] = await Promise.all([
            lift && busy(lift, day1),
            employee && busy(employee, day1),
            day2 && lift && busy(lift, day2),
            day2 && employee && busy(employee, day2),
          ]);
          if (dto.liftId && conflict1) throw new BadRequestException(err('err.calendar.liftBusy'));
          if (dto.employeeId && empConflict1)
            throw new BadRequestException(err('err.calendar.employeeBusy'));
          if (dto.liftId && conflict2)
            throw new BadRequestException(err('err.calendar.liftBusyNextDay'));
          if (dto.employeeId && empConflict2)
            throw new BadRequestException(err('err.calendar.employeeBusyNextDay'));

          const slotData = {
            orgId,
            liftId: dto.liftId ?? null,
            employeeId: dto.employeeId ?? null,
            workOrderId: null,
            counterpartyId: dto.counterpartyId ?? null,
            vehicleId: dto.vehicleId ?? null,
            notes: dto.notes ?? null,
            status: dto.status ?? CalendarSlotStatus.BOOKED,
            type: dto.type ?? CalendarSlotType.WORK,
          };

          const created1 = await tx.calendarSlot.create({
            data: { ...slotData, startAt, endAt: slot1End },
            include: SLOT_INCLUDE,
          });

          if (!isSplit) return [created1];

          const created2 = await tx.calendarSlot.create({
            data: {
              ...slotData,
              startAt: slot2Start!,
              endAt: slot2End!,
              parentSlotId: created1.id,
            },
            include: SLOT_INCLUDE,
          });

          return [created1, created2];
          // Explicit 5s timeout: 2 conflict checks + 1-2 creates — well below Prisma default 30s.
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
    } catch (e) {
      // CAL-C1 backstop: DB EXCLUDE-constraint зловив пересічний слот, який обійшов app-probe
      // (concurrent booking). Конвертуємо у 409 UA замість generic 500.
      throwIfExclusionConflict(e, slotExclusionMessages());
    }

    return { slots: slots.map(s => this.toDto(s)) };
  }

  /**
   * Зміна запису сама по собі. Зміну часу чи підйомника запису НАРЯДУ проводить наряд
   * (`WorkOrdersService.updateCalendarSlot`, BR-WO-024) — сюди вона не доходить: і
   * `PATCH /calendar/slots/:id`, і синхронізація з планшета ідуть через нього.
   *
   * `opts.inTx` — що ще зробити в транзакції зміни запису, ПЕРЕД записом самого запису (порядок
   * блокувань «наряд → записи», як у збереженні наряду): відв'язаний від наряду запис стирає дати
   * наряду (BR-WO-026, `WorkOrdersService.unlinkCalendarSlot`).
   */
  async updateSlot(
    orgId: string,
    id: string,
    dto: CalendarSlotEdit,
    opts: { inTx?: (tx: Prisma.TransactionClient) => Promise<void> } = {},
  ): Promise<CalendarSlotResponseDto> {
    // MVP: slots that have a continuation (split across days) must be edited individually.
    const hasContinuation = await this.prisma.calendarSlot.findFirst({
      where: { parentSlotId: id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (hasContinuation) {
      throw new BadRequestException(err('err.calendar.slotSplitTwoDays'));
    }

    // Existing slot + independent FK ownership checks run in parallel; error priority preserved below
    const checkLift = dto.liftId !== undefined && dto.liftId !== null;
    const checkWorkOrder = dto.workOrderId !== undefined && dto.workOrderId !== null;
    const checkCounterparty = dto.counterpartyId !== undefined && dto.counterpartyId !== null;
    const checkVehicle = dto.vehicleId !== undefined && dto.vehicleId !== null;
    const [existing, lift, workOrder, counterparty, vehicle] = await Promise.all([
      // existing — потрібен повним: startAt/endAt/liftId/employeeId юзаються нижче.
      this.prisma.calendarSlot.findFirst({ where: { id, orgId, deletedAt: null } }),
      // FK guards — narrow projection (тільки існування важливе для NotFoundException).
      checkLift
        ? this.prisma.lift.findFirst({
            where: { id: dto.liftId!, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      checkWorkOrder
        ? this.prisma.workOrder.findFirst({
            where: { id: dto.workOrderId!, orgId, deletedAt: null },
            select: { id: true, status: true },
          })
        : Promise.resolve(null),
      checkCounterparty
        ? this.prisma.counterparty.findFirst({
            where: { id: dto.counterpartyId!, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      checkVehicle
        ? this.prisma.vehicle.findFirst({
            where: { id: dto.vehicleId!, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (!existing) throw new NotFoundException(err('err.calendar.slotNotFound'));
    // BR-CAL-003: службовий запис не отримує клієнта, авто чи наряду — і поза
    // `WorkOrdersService.updateCalendarSlot` (той перевіряє раніше), як `createSlot`.
    assertServiceSlotUnlinked(existing.type, dto);
    if (checkLift && !lift) throw new NotFoundException(err('err.lift.notFound'));
    if (checkWorkOrder && !workOrder)
      throw new NotFoundException(err('err.calendar.workOrderNotFound'));
    // BR-WO-022: запис скасованого наряду ніде не показується і не рахується зайнятим, але
    // EXCLUDE `calendar_slots_no_overlap` його бачить — живий запис став би невидимим тримачем
    // підйомника (409 на вільному з вигляду часі).
    if (workOrder?.status === WorkOrderStatus.CANCELLED)
      throw new BadRequestException(err('err.calendar.workOrderCancelled'));
    if (checkCounterparty && !counterparty)
      throw new NotFoundException(err('err.calendar.clientNotFound'));
    if (checkVehicle && !vehicle) throw new NotFoundException(err('err.calendar.vehicleNotFound'));

    const startAt = dto.startAt ? new Date(dto.startAt) : existing.startAt;
    const endAt = dto.endAt ? new Date(dto.endAt) : existing.endAt;
    if (endAt <= startAt) throw new BadRequestException(err('err.calendar.endBeforeStart'));

    const liftId = dto.liftId !== undefined ? dto.liftId : existing.liftId;

    let employeeId = dto.employeeId !== undefined ? dto.employeeId : existing.employeeId;
    let mechanicDroppedReason: MechanicRejectReason | null = null;

    // BR-CAL-012: механіка перевіряє лише зміна механіка чи підйомника. Форма шле обидва поля
    // щоразу, тож порівнюється з БД, а не «поле є в запиті»: збережений механік, якого вже
    // звільнили чи відкріпили, не заважає змінити час чи нотатки запису.
    if (employeeId && (employeeId !== existing.employeeId || liftId !== existing.liftId)) {
      const mechanic = await findMechanicOnLift(this.prisma, orgId, employeeId, liftId);
      // Перетягування у «Дні» (`dropMechanicNotOnLift`) знімає СВІЙ механік запису, не
      // закріплений за новим підйомником (чи у відпустці), замість 400 — з причиною у відповіді.
      // Явно обраного іншого механіка не знімає: це вибір користувача, і він отримує 400, як у
      // формі.
      if (!mechanic.ok) {
        const drop = dto.dropMechanicNotOnLift === true && employeeId === existing.employeeId;
        if (!drop) throw new BadRequestException(err(MECHANIC_REJECT_KEY[mechanic.reason]));
        employeeId = null;
        mechanicDroppedReason = mechanic.reason;
      }
    }

    let updated;
    try {
      updated = await this.prisma.$transaction(
        async tx => {
          // Lift- + employee-conflict checks незалежні — паралелимо; сам запис — не конфлікт.
          // Narrow projection (select id) — потрібен лише факт існування.
          const busy = (resource: Prisma.CalendarSlotWhereInput) =>
            tx.calendarSlot.findFirst({
              where: busyWhere(orgId, resource, [{ startAt, endAt }], { ids: [id] }),
              select: { id: true },
            });
          const [conflict, empConflict] = await Promise.all([
            liftId ? busy({ liftId }) : null,
            employeeId ? busy({ employeeId }) : null,
          ]);
          if (liftId && conflict) {
            throw new BadRequestException(err('err.calendar.liftBusy'));
          }
          if (employeeId && empConflict) {
            throw new BadRequestException(err('err.calendar.employeeBusy'));
          }

          await opts.inTx?.(tx);
          return tx.calendarSlot.update({
            where: { id, orgId },
            data: {
              ...(dto.liftId !== undefined && { liftId: dto.liftId }),
              ...((dto.employeeId !== undefined || mechanicDroppedReason !== null) && {
                employeeId,
              }),
              ...(dto.workOrderId !== undefined && { workOrderId: dto.workOrderId }),
              ...(dto.counterpartyId !== undefined && { counterpartyId: dto.counterpartyId }),
              ...(dto.vehicleId !== undefined && { vehicleId: dto.vehicleId }),
              startAt,
              endAt,
              ...(dto.notes !== undefined && { notes: dto.notes }),
            },
            include: SLOT_INCLUDE,
          });
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
    } catch (e) {
      throwIfExclusionConflict(e, slotExclusionMessages());
    }

    const res = this.toDto(updated);
    return mechanicDroppedReason ? { ...res, mechanicDropped: true, mechanicDroppedReason } : res;
  }

  async checkConflicts(orgId: string, dto: CheckConflictsDto): Promise<CheckConflictsResponseDto> {
    if (!dto.liftId && !dto.employeeId) {
      // No resource selected — nothing to conflict against. Short-circuit без RTT.
      return {
        liftConflict: false,
        employeeConflict: false,
        anyConflict: false,
        conflictSlots: [],
      };
    }
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) {
      throw new BadRequestException(err('err.calendar.invalidTimeInterval'));
    }
    // excludeWorkOrderId — записи самого наряду (картка наряду перевіряє власний час) не конфлікт;
    // записи без наряду лишаються конфліктом (`busyWhere`, BR-WO-020).
    const exclude = {
      ids: dto.excludeSlotId ? [dto.excludeSlotId] : undefined,
      workOrderId: dto.excludeWorkOrderId,
    };
    // findMany without take violates OOM guard — realistic upper bound for a time window is a few dozen slots.
    const CONFLICT_TAKE = 50;
    // CONFLICT_SELECT hoisted to module-level (sto-optimize cycle 3/3).
    const busy = (resource: Prisma.CalendarSlotWhereInput) =>
      this.prisma.calendarSlot.findMany({
        where: busyWhere(orgId, resource, [{ startAt, endAt }], exclude),
        select: CONFLICT_SELECT,
        take: CONFLICT_TAKE,
      });

    const [liftSlots, empSlots] = await Promise.all([
      dto.liftId ? busy({ liftId: dto.liftId }) : [],
      dto.employeeId ? busy({ employeeId: dto.employeeId }) : [],
    ]);

    const seen = new Set<string>();
    const allSlots = [...liftSlots, ...empSlots].filter(s => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });

    return {
      liftConflict: liftSlots.length > 0,
      employeeConflict: empSlots.length > 0,
      anyConflict: allSlots.length > 0,
      conflictSlots: allSlots.map(s => this.toConflictDto(s)),
    };
  }

  /**
   * BR-WO-020: запис календаря наряду з плановими початком і завершенням — у транзакції
   * збереження наряду (`tx`), тож зайнятий підйомник чи механік (400) відкочує й сам наряд.
   *
   * - Проміжок [startAt, endAt) ділиться на робочі години філії наряду: по запису на день
   *   (перший — «якір», решта — продовження з `parentSlotId`, як багатоденний запис BR-CAL-007).
   *   Плановий початок/завершення — мить, а не тривалість, тож другий день закінчується о
   *   `dueDate`, а не «залишок тривалості від відкриття».
   * - Наявний якір наряду переноситься на місці: зберігаються id, механік, статус, тип і нотатки;
   *   продовження й зайві записи наряду позначаються видаленими й створюються заново — один
   *   запис на наряд.
   * - Механік зберігається; зміна підйомника знімає механіка, не закріпленого за новим (чи
   *   у відпустці, чи звільненого), як перетягування у «Дні» (BR-CAL-012). Без зміни підйомника
   *   механіка не перевіряє.
   * - Зайнятість — як у `createSlot`: інші записи на підйомнику / у механіка, записи видалених
   *   нарядів не рахуються (BR-CAL-011); власні записи наряду — не конфлікт.
   * - `isNew` — наряд створено в цій самій транзакції: власних записів у нього ще немає, тож
   *   їх пошук (завжди порожній) пропускається — на один запит до БД менше на створення.
   *
   * - `employeeId` / `notes` — зміна запису наряду з форми чи планшета (BR-WO-024): механік і
   *   примітка для всього ланцюжка замість збережених на якорі. Механіка, обраного явно,
   *   перевіряє той, хто кличе (форма відповідає 400, а не знімає його).
   *
   * Повертає причину, з якої механіка запису знято (BR-CAL-012), або `null` — перетягування
   * запису наряду показує за нею «Механіка знято: …» (BR-WO-023).
   */
  async upsertWorkOrderSlot(
    tx: Prisma.TransactionClient,
    args: {
      orgId: string;
      workOrderId: string;
      branchId: string;
      liftId: string | null;
      startAt: Date;
      endAt: Date;
      vehicleId: string | null;
      counterpartyId: string | null;
      hours?: WorkHours;
      isNew?: boolean;
      employeeId?: string | null;
      notes?: string | null;
    },
  ): Promise<{ mechanicDroppedReason: MechanicRejectReason | null }> {
    const { orgId, workOrderId, liftId } = args;
    const hours = args.hours ?? (await this.resolveWorkHours(orgId, args.branchId));
    const split = splitByWorkHours(args.startAt, args.endAt, hours);
    // Поза робочими годинами бувають лише старі незмінені дати (BR-WO-019 їх не перевіряє, а
    // запис переноситься, бо змінився підйомник) — такий запис лишається одним відрізком.
    const segments: TimeSegment[] =
      split.length > 0 ? split : [{ startAt: args.startAt, endAt: args.endAt }];
    const [first, ...rest] = segments as [TimeSegment, ...TimeSegment[]];

    const own = args.isNew
      ? []
      : await tx.calendarSlot.findMany({
          where: { orgId, workOrderId, deletedAt: null },
          select: {
            id: true,
            parentSlotId: true,
            liftId: true,
            employeeId: true,
            status: true,
            type: true,
            notes: true,
          },
          orderBy: { startAt: 'asc' },
          take: 500,
        });
    const anchor = own.find(s => s.parentSlotId === null) ?? null;

    let employeeId = args.employeeId !== undefined ? args.employeeId : (anchor?.employeeId ?? null);
    const notes = args.notes !== undefined ? args.notes : (anchor?.notes ?? null);
    let mechanicDroppedReason: MechanicRejectReason | null = null;
    if (anchor && employeeId && liftId !== anchor.liftId) {
      const mechanic = await findMechanicOnLift(tx, orgId, employeeId, liftId);
      if (!mechanic.ok) {
        employeeId = null;
        mechanicDroppedReason = mechanic.reason;
      }
    }

    const ownIds = own.map(s => s.id);
    const busy = (resource: { liftId: string } | { employeeId: string }) =>
      tx.calendarSlot.findFirst({
        where: busyWhere(orgId, resource, segments, { ids: ownIds }),
        select: { startAt: true, endAt: true },
      });
    const [liftHit, mechanicHit] = await Promise.all([
      liftId ? busy({ liftId }) : null,
      employeeId ? busy({ employeeId }) : null,
    ]);
    // Перетин із першим днем — «зайнятий», лише з наступними — «зайнятий наступного дня».
    const busyError = (hit: TimeSegment, sameDayKey: string, nextDayKey: string) =>
      new BadRequestException(
        err(hit.startAt < first.endAt && hit.endAt > first.startAt ? sameDayKey : nextDayKey),
      );
    if (liftHit) throw busyError(liftHit, 'err.calendar.liftBusy', 'err.calendar.liftBusyNextDay');
    if (mechanicHit)
      throw busyError(mechanicHit, 'err.calendar.employeeBusy', 'err.calendar.employeeBusyNextDay');

    // Спершу звільнити старі продовження: інакше перенесений якір перетнувся б із власним
    // продовженням на тому ж підйомнику (EXCLUDE `calendar_slots_no_overlap`).
    const stale = ownIds.filter(id => id !== anchor?.id);
    if (stale.length > 0) {
      await tx.calendarSlot.updateMany({
        where: { orgId, id: { in: stale }, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }

    const shared = {
      orgId,
      workOrderId,
      liftId,
      employeeId,
      vehicleId: args.vehicleId,
      counterpartyId: args.counterpartyId,
      status: anchor?.status ?? CalendarSlotStatus.BOOKED,
      type: anchor?.type ?? CalendarSlotType.WORK,
      notes,
    };
    let anchorId: string;
    if (anchor) {
      await tx.calendarSlot.update({
        where: { id: anchor.id, orgId },
        data: {
          liftId,
          employeeId,
          startAt: first.startAt,
          endAt: first.endAt,
          ...(args.notes !== undefined && { notes }),
        },
        select: { id: true },
      });
      anchorId = anchor.id;
    } else {
      const created = await tx.calendarSlot.create({
        data: { ...shared, startAt: first.startAt, endAt: first.endAt },
        select: { id: true },
      });
      anchorId = created.id;
    }
    if (rest.length > 0) {
      await tx.calendarSlot.createMany({
        data: rest.map(s => ({
          ...shared,
          parentSlotId: anchorId,
          startAt: s.startAt,
          endAt: s.endAt,
        })),
      });
    }
    return { mechanicDroppedReason };
  }

  /**
   * BR-WO-017/020: наряд видалено чи його планові дати стерто — записи календаря наряду (обидві
   * частини багатоденного) позначаються видаленими в транзакції наряду; підйомник і механік
   * звільняються. `deletedAt` — той самий час, що й у видаленого наряду.
   */
  async removeWorkOrderSlots(
    tx: Prisma.TransactionClient,
    orgId: string,
    workOrderId: string,
    deletedAt: Date = new Date(),
  ): Promise<void> {
    await tx.calendarSlot.updateMany({
      where: { orgId, workOrderId, deletedAt: null },
      data: { deletedAt },
    });
  }

  /**
   * BR-WO-027: примітка й механік багатоденного запису наряду, чий наряд не в редагованому статусі,
   * — для всього ланцюжка (`chain`: якір і продовження) без перебудови: час і підйомник таких
   * записів не змінюються, а збереження наряду закритий наряд не редагує. Механік — вільний на всіх
   * днях ланцюжка (BR-CAL-005); закріплення за підйомником (BR-CAL-012) перевіряє той, хто кличе.
   *
   * Відв'язка багатоденного запису від наряду (BR-WO-026, Bug #906) — тим самим шляхом: клієнт і
   * авто форми для всього ланцюжка; `opts.inTx` — що зробити в транзакції ПЕРЕД записом ланцюжка
   * (порядок блокувань «наряд → записи»: відв'язати ланцюжок і стерти дати наряду).
   */
  async updateSlotChainDetails(
    orgId: string,
    chain: readonly ({ id: string } & TimeSegment)[],
    change: {
      employeeId?: string | null | undefined;
      notes?: string | null | undefined;
      counterpartyId?: string | null | undefined;
      vehicleId?: string | null | undefined;
    },
    opts: { inTx?: (tx: Prisma.TransactionClient) => Promise<void> } = {},
  ): Promise<void> {
    const data = {
      ...(change.employeeId !== undefined && { employeeId: change.employeeId }),
      ...(change.notes !== undefined && { notes: change.notes }),
      ...(change.counterpartyId !== undefined && { counterpartyId: change.counterpartyId }),
      ...(change.vehicleId !== undefined && { vehicleId: change.vehicleId }),
    };
    if ((Object.keys(data).length === 0 && !opts.inTx) || chain.length === 0) return;
    const ids = chain.map(s => s.id);
    const segments = [...chain].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    const first = segments[0];
    const { employeeId } = change;
    // Проба механіка на READ COMMITTED не бачить паралельного запису — його ловить EXCLUDE
    // `calendar_slots_mechanic_no_overlap`, і гонка дає 409 «механік зайнятий», а не 500.
    await this.prisma
      .$transaction(
        async tx => {
          if (employeeId) {
            const hit = await tx.calendarSlot.findFirst({
              where: busyWhere(orgId, { employeeId }, segments, { ids }),
              select: { startAt: true, endAt: true },
            });
            if (hit)
              throw new BadRequestException(
                err(
                  hit.startAt < first.endAt && hit.endAt > first.startAt
                    ? 'err.calendar.employeeBusy'
                    : 'err.calendar.employeeBusyNextDay',
                ),
              );
          }
          await opts.inTx?.(tx);
          if (Object.keys(data).length > 0)
            await tx.calendarSlot.updateMany({
              where: { orgId, id: { in: ids }, deletedAt: null },
              data,
            });
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      )
      .catch((e: unknown) => throwIfExclusionConflict(e, slotExclusionMessages()));
  }

  /** Живий запис календаря за id (відповідь зміни ланцюжка без перебудови, Bug #906). */
  async findSlotById(orgId: string, id: string): Promise<CalendarSlotResponseDto | null> {
    const slot = await this.prisma.calendarSlot.findFirst({
      where: { id, orgId, deletedAt: null },
      include: SLOT_INCLUDE,
    });
    return slot ? this.toDto(slot) : null;
  }

  /**
   * Записи наряду (якір і продовження) за часом — відповідь створення запису для наряду
   * (`POST /calendar/slots` з `workOrderId`, BR-WO-028, Bug #905): запис стає записом наряду.
   */
  async findWorkOrderSlots(orgId: string, workOrderId: string): Promise<CalendarSlotResponseDto[]> {
    const slots = await this.prisma.calendarSlot.findMany({
      where: { orgId, workOrderId, deletedAt: null },
      orderBy: { startAt: 'asc' },
      include: SLOT_INCLUDE,
      take: 500,
    });
    return slots.map(s => this.toDto(s));
  }

  /**
   * Якір запису наряду (BR-WO-024) — відповідь зміни запису, яку провів наряд: продовження сервер
   * перебудовує (нові id), тож змінений запис міг зникнути, а якір лишається.
   */
  async findWorkOrderAnchor(
    orgId: string,
    workOrderId: string,
  ): Promise<CalendarSlotResponseDto | null> {
    const slot = await this.prisma.calendarSlot.findFirst({
      where: { orgId, workOrderId, parentSlotId: null, deletedAt: null },
      orderBy: { startAt: 'asc' },
      include: SLOT_INCLUDE,
    });
    return slot ? this.toDto(slot) : null;
  }

  async removeSlot(orgId: string, id: string): Promise<void> {
    // Race-safe 1-RTT soft delete via updateMany — compound where (id+orgId+deletedAt:null)
    // блокує double-delete race. Той самий патерн що 8 інших remove() сервісів (cycle 1).
    const result = await this.prisma.calendarSlot.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException(err('err.calendar.slotNotFound'));
  }

  /** Minimal DTO for conflict-check response — no PII fields, no counterparty enumeration. */
  private toConflictDto(slot: {
    id: string;
    liftId: string | null;
    employeeId: string | null;
    workOrderId: string | null;
    parentSlotId?: string | null;
    startAt: Date;
    endAt: Date;
    status: CalendarSlotStatus;
    type: CalendarSlotType;
    workOrder: { number: string; status: string; deletedAt: Date | null } | null;
    employeeName?: string | null;
  }): CalendarSlotResponseDto {
    return {
      id: slot.id,
      liftId: slot.liftId ?? null,
      employeeId: slot.employeeId ?? null,
      workOrderId: slot.workOrderId ?? null,
      vehicleId: null,
      parentSlotId: slot.parentSlotId ?? null,
      startAt: slot.startAt instanceof Date ? slot.startAt.toISOString() : slot.startAt,
      endAt: slot.endAt instanceof Date ? slot.endAt.toISOString() : slot.endAt,
      notes: null,
      status: slot.status,
      type: slot.type,
      workOrderNumber: slot.workOrder?.number,
      workOrderStatus: slot.workOrder?.status ?? null,
      workOrderDeleted: !!slot.workOrder?.deletedAt,
      counterpartyId: null,
      counterpartyName: undefined,
      cpPhone: null,
      vehicleSummary: null,
      vehiclePlate: null,
      ...(slot.employeeName !== undefined && { employeeName: slot.employeeName }),
    };
  }

  private toDto(slot: {
    id: string;
    liftId: string | null;
    employeeId: string | null;
    workOrderId: string | null;
    vehicleId?: string | null;
    counterpartyId?: string | null;
    parentSlotId?: string | null;
    startAt: Date;
    endAt: Date;
    notes: string | null;
    status: CalendarSlotStatus;
    type: CalendarSlotType;
    vehicle?: { make: string; model: string; licensePlate: string | null } | null;
    workOrder: {
      number: string;
      status: string;
      deletedAt: Date | null;
      counterpartyId: string;
      counterparty: {
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
        phone: string | null;
      } | null;
      vehicle: { make: string; model: string; licensePlate: string | null } | null;
    } | null;
    counterparty?: {
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
      phone: string | null;
    } | null;
    /** Лише з `findSlots` (BR-CAL-011); без нього поля в DTO немає. */
    employeeName?: string | null;
  }): CalendarSlotResponseDto {
    const woCp = slot.workOrder?.counterparty;
    const directCp = slot.counterparty;
    const cp = woCp ?? directCp;
    const counterpartyName = cp
      ? formatPersonName(cp.lastName, cp.firstName, cp.companyName) || undefined
      : undefined;
    const cpPhone = cp?.phone ?? null;

    const counterpartyId = slot.counterpartyId ?? slot.workOrder?.counterpartyId ?? null;

    // Direct slot vehicle takes priority over vehicle from workOrder
    const v = slot.vehicle ?? slot.workOrder?.vehicle;
    const vehicleSummary = v ? [v.make, v.model].filter(Boolean).join(' ') : null;
    const vehiclePlate = v?.licensePlate ?? null;

    return {
      id: slot.id,
      liftId: slot.liftId ?? null,
      employeeId: slot.employeeId ?? null,
      workOrderId: slot.workOrderId ?? null,
      vehicleId: slot.vehicleId ?? null,
      parentSlotId: slot.parentSlotId ?? null,
      startAt: slot.startAt instanceof Date ? slot.startAt.toISOString() : slot.startAt,
      endAt: slot.endAt instanceof Date ? slot.endAt.toISOString() : slot.endAt,
      notes: slot.notes ?? null,
      status: slot.status,
      type: slot.type,
      workOrderNumber: slot.workOrder?.number,
      workOrderStatus: slot.workOrder?.status ?? null,
      workOrderDeleted: !!slot.workOrder?.deletedAt,
      counterpartyId,
      counterpartyName,
      cpPhone,
      vehicleSummary,
      vehiclePlate,
      ...(slot.employeeName !== undefined && { employeeName: slot.employeeName }),
    };
  }
}
