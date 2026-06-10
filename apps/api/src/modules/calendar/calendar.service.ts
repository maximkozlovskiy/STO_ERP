import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { CalendarSlotStatus, CalendarSlotType } from '@prisma/client';
import { formatPersonName, TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateCalendarSlotDto,
  UpdateCalendarSlotDto,
  CalendarSlotResponseDto,
  CreateCalendarSlotResponseDto,
  CheckConflictsDto,
  CheckConflictsResponseDto,
} from './calendar.dto';

// Module-level Intl singleton — kyivOffsetMs is called on every findSlots/createSlot/updateSlot,
// avoid re-allocating the DateTimeFormat on each request.
const KYIV_HOUR_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv',
  hour: '2-digit',
  hour12: false,
});

const KYIV_DATE_FMT = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });

// Working day boundaries (hardcoded for MVP; will come from BranchSettings later).
const WORK_DAY_START_H = 8;
const WORK_DAY_END_H = 19;

/** Returns the UTC timestamp for 19:00 Kyiv time on the same calendar day as `d`. */
function kyivEndOfWorkDay(d: Date): Date {
  const kyivDate = KYIV_DATE_FMT.format(d); // "YYYY-MM-DD"
  // Build "YYYY-MM-DDT19:00:00" as a local Kyiv wall-clock time, then convert to UTC.
  // We use the same DST-aware approach: find the UTC offset at noon of that day.
  const noonUtc = new Date(`${kyivDate}T12:00:00Z`);
  const offsetMs = kyivOffsetMsStatic(noonUtc);
  return new Date(
    new Date(`${kyivDate}T${String(WORK_DAY_END_H).padStart(2, '0')}:00:00Z`).getTime() - offsetMs,
  );
}

/** Returns the UTC timestamp for 08:00 Kyiv time on the calendar day AFTER `d`. */
function kyivStartOfNextWorkDay(d: Date): Date {
  const kyivDate = KYIV_DATE_FMT.format(d); // "YYYY-MM-DD"
  const [y, m, day] = kyivDate.split('-').map(Number);
  const nextDay = new Date(Date.UTC(y!, m! - 1, day! + 1));
  const nextDateStr = KYIV_DATE_FMT.format(nextDay);
  const noonUtc = new Date(`${nextDateStr}T12:00:00Z`);
  const offsetMs = kyivOffsetMsStatic(noonUtc);
  return new Date(
    new Date(`${nextDateStr}T${String(WORK_DAY_START_H).padStart(2, '0')}:00:00Z`).getTime() -
      offsetMs,
  );
}

function kyivOffsetMsStatic(d: Date): number {
  const utcHour = d.getUTCHours();
  const kyivHour = parseInt(KYIV_HOUR_FMT.format(d), 10);
  return ((kyivHour - utcHour + 24) % 24) * 3600000;
}

@Injectable()
export class CalendarService {
  constructor(private readonly prisma: PrismaService) {}

  async findSlots(
    orgId: string,
    date: string,
    branchId?: string,
    employeeId?: string,
  ): Promise<CalendarSlotResponseDto[]> {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new BadRequestException('Невірний формат дати. Очікується YYYY-MM-DD');
    // Convert Kyiv calendar date to UTC range using Intl (handles DST correctly)
    const kyivOffset = this.kyivOffsetMs(new Date(`${date}T12:00:00Z`));
    const start = new Date(new Date(`${date}T00:00:00Z`).getTime() - kyivOffset);
    const end = new Date(new Date(`${date}T23:59:59.999Z`).getTime() - kyivOffset);

    const where: {
      orgId: string;
      deletedAt: null;
      startAt: { gte: Date };
      endAt: { lte: Date };
      lift?: { zone: { branchId: string; orgId: string } };
      employeeId?: string;
    } = {
      orgId,
      deletedAt: null,
      startAt: { gte: start },
      endAt: { lte: end },
    };
    if (branchId) where.lift = { zone: { branchId, orgId } };
    if (employeeId) where.employeeId = employeeId;

    const slots = await this.prisma.calendarSlot.findMany({
      where,
      orderBy: { startAt: 'asc' },
      include: {
        counterparty: {
          select: { firstName: true, lastName: true, companyName: true, phone: true },
        },
        vehicle: { select: { make: true, model: true, licensePlate: true } },
        workOrder: {
          select: {
            number: true,
            counterpartyId: true,
            counterparty: {
              select: { firstName: true, lastName: true, companyName: true, phone: true },
            },
            vehicle: { select: { make: true, model: true, licensePlate: true } },
          },
        },
      },
      take: 500,
    });

    return slots.map(item => this.toDto(item));
  }

  async createSlot(
    orgId: string,
    dto: CreateCalendarSlotDto,
  ): Promise<CreateCalendarSlotResponseDto> {
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);

    if (endAt <= startAt) throw new BadRequestException('Час завершення має бути після початку');

    // Validate FK ownership to prevent cross-tenant injection — independent checks run in parallel.
    // Narrow projection — потрібне лише існування (NotFoundException), не дані.
    const [lift, employee, workOrder, counterparty, vehicle] = await Promise.all([
      dto.liftId
        ? this.prisma.lift.findFirst({
            where: { id: dto.liftId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.employeeId
        ? this.prisma.employee.findFirst({
            where: { id: dto.employeeId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.workOrderId
        ? this.prisma.workOrder.findFirst({
            where: { id: dto.workOrderId, orgId, deletedAt: null },
            select: { id: true },
          })
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
    if (dto.liftId && !lift) throw new NotFoundException('Підйомник не знайдено');
    if (dto.employeeId && !employee) throw new NotFoundException('Співробітника не знайдено');
    if (dto.workOrderId && !workOrder) throw new NotFoundException('Наряд не знайдено');
    if (dto.counterpartyId && !counterparty) throw new NotFoundException('Клієнта не знайдено');
    if (dto.vehicleId && !vehicle) throw new NotFoundException('Автомобіль не знайдено');

    // Determine if slot overflows the working day end (19:00 Kyiv)
    const workDayEnd = kyivEndOfWorkDay(startAt);
    const isSplit = endAt > workDayEnd;

    const slot1End = isSplit ? workDayEnd : endAt;
    const slot2Start = isSplit ? kyivStartOfNextWorkDay(startAt) : null;
    const slot2End = isSplit
      ? new Date(slot2Start!.getTime() + (endAt.getTime() - workDayEnd.getTime()))
      : null;

    const SLOT_INCLUDE = {
      counterparty: {
        select: { firstName: true, lastName: true, companyName: true, phone: true } as const,
      },
      vehicle: { select: { make: true, model: true, licensePlate: true } as const },
      workOrder: {
        select: {
          number: true,
          counterpartyId: true,
          counterparty: {
            select: { firstName: true, lastName: true, companyName: true, phone: true } as const,
          },
          vehicle: { select: { make: true, model: true, licensePlate: true } as const },
        },
      },
    } as const;

    const slots = await this.prisma.$transaction(
      async tx => {
        // Conflict check for slot1 interval (+ slot2 interval if split) — all in parallel.
        const [conflict1, empConflict1, conflict2, empConflict2] = await Promise.all([
          dto.liftId
            ? tx.calendarSlot.findFirst({
                where: {
                  orgId,
                  liftId: dto.liftId,
                  deletedAt: null,
                  OR: [{ startAt: { lt: slot1End }, endAt: { gt: startAt } }],
                },
                select: { id: true },
              })
            : Promise.resolve(null),
          dto.employeeId
            ? tx.calendarSlot.findFirst({
                where: {
                  orgId,
                  employeeId: dto.employeeId,
                  deletedAt: null,
                  OR: [{ startAt: { lt: slot1End }, endAt: { gt: startAt } }],
                },
                select: { id: true },
              })
            : Promise.resolve(null),
          isSplit && dto.liftId
            ? tx.calendarSlot.findFirst({
                where: {
                  orgId,
                  liftId: dto.liftId,
                  deletedAt: null,
                  OR: [{ startAt: { lt: slot2End! }, endAt: { gt: slot2Start! } }],
                },
                select: { id: true },
              })
            : Promise.resolve(null),
          isSplit && dto.employeeId
            ? tx.calendarSlot.findFirst({
                where: {
                  orgId,
                  employeeId: dto.employeeId,
                  deletedAt: null,
                  OR: [{ startAt: { lt: slot2End! }, endAt: { gt: slot2Start! } }],
                },
                select: { id: true },
              })
            : Promise.resolve(null),
        ]);
        if (dto.liftId && conflict1)
          throw new BadRequestException('Підйомник вже зайнятий на цей час');
        if (dto.employeeId && empConflict1)
          throw new BadRequestException('Співробітник вже зайнятий на цей час');
        if (dto.liftId && conflict2)
          throw new BadRequestException('Підйомник вже зайнятий на наступний день');
        if (dto.employeeId && empConflict2)
          throw new BadRequestException('Співробітник вже зайнятий на наступний день');

        const slotData = {
          orgId,
          liftId: dto.liftId ?? null,
          employeeId: dto.employeeId ?? null,
          workOrderId: dto.workOrderId ?? null,
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
          data: { ...slotData, startAt: slot2Start!, endAt: slot2End!, parentSlotId: created1.id },
          include: SLOT_INCLUDE,
        });

        return [created1, created2];
        // Bug #130: explicit 5s timeout (2 conflict checks + 1-2 creates — well below default).
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    return { slots: slots.map(s => this.toDto(s)) };
  }

  async updateSlot(
    orgId: string,
    id: string,
    dto: UpdateCalendarSlotDto,
  ): Promise<CalendarSlotResponseDto> {
    // MVP: slots that have a continuation (split across days) must be edited individually.
    const hasContinuation = await this.prisma.calendarSlot.findFirst({
      where: { parentSlotId: id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (hasContinuation) {
      throw new BadRequestException('Слот розбитий на 2 дні — редагуйте кожен окремо');
    }

    // Existing slot + independent FK ownership checks run in parallel; error priority preserved below
    const checkLift = dto.liftId !== undefined && dto.liftId !== null;
    const checkEmployee = dto.employeeId !== undefined && dto.employeeId !== null;
    const checkWorkOrder = dto.workOrderId !== undefined && dto.workOrderId !== null;
    const checkCounterparty = dto.counterpartyId !== undefined && dto.counterpartyId !== null;
    const checkVehicle = dto.vehicleId !== undefined && dto.vehicleId !== null;
    const [existing, lift, employee, workOrder, counterparty, vehicle] = await Promise.all([
      // existing — потрібен повним: startAt/endAt/liftId/employeeId юзаються нижче.
      this.prisma.calendarSlot.findFirst({ where: { id, orgId, deletedAt: null } }),
      // FK guards — narrow projection (тільки існування важливе для NotFoundException).
      checkLift
        ? this.prisma.lift.findFirst({
            where: { id: dto.liftId!, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      checkEmployee
        ? this.prisma.employee.findFirst({
            where: { id: dto.employeeId!, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      checkWorkOrder
        ? this.prisma.workOrder.findFirst({
            where: { id: dto.workOrderId!, orgId, deletedAt: null },
            select: { id: true },
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
    if (!existing) throw new NotFoundException('Слот не знайдено');
    if (checkLift && !lift) throw new NotFoundException('Підйомник не знайдено');
    if (checkEmployee && !employee) throw new NotFoundException('Співробітника не знайдено');
    if (checkWorkOrder && !workOrder) throw new NotFoundException('Наряд не знайдено');
    if (checkCounterparty && !counterparty) throw new NotFoundException('Клієнта не знайдено');
    if (checkVehicle && !vehicle) throw new NotFoundException('Автомобіль не знайдено');

    const startAt = dto.startAt ? new Date(dto.startAt) : existing.startAt;
    const endAt = dto.endAt ? new Date(dto.endAt) : existing.endAt;
    if (endAt <= startAt) throw new BadRequestException('Час завершення має бути після початку');

    const liftId = dto.liftId !== undefined ? dto.liftId : existing.liftId;

    const employeeId = dto.employeeId !== undefined ? dto.employeeId : existing.employeeId;

    const updated = await this.prisma.$transaction(
      async tx => {
        // Lift- + employee-conflict checks незалежні — паралелимо.
        // Narrow projection (select id) — потрібен лише факт існування.
        const [conflict, empConflict] = await Promise.all([
          liftId
            ? tx.calendarSlot.findFirst({
                where: {
                  orgId,
                  liftId,
                  deletedAt: null,
                  NOT: { id },
                  OR: [{ startAt: { lt: endAt }, endAt: { gt: startAt } }],
                },
                select: { id: true },
              })
            : Promise.resolve(null),
          employeeId
            ? tx.calendarSlot.findFirst({
                where: {
                  orgId,
                  employeeId,
                  deletedAt: null,
                  NOT: { id },
                  OR: [{ startAt: { lt: endAt }, endAt: { gt: startAt } }],
                },
                select: { id: true },
              })
            : Promise.resolve(null),
        ]);
        if (liftId && conflict) {
          throw new BadRequestException('Підйомник вже зайнятий на цей час');
        }
        if (employeeId && empConflict) {
          throw new BadRequestException('Співробітник вже зайнятий на цей час');
        }

        return tx.calendarSlot.update({
          where: { id, orgId },
          data: {
            ...(dto.liftId !== undefined && { liftId: dto.liftId }),
            ...(dto.employeeId !== undefined && { employeeId: dto.employeeId }),
            ...(dto.workOrderId !== undefined && { workOrderId: dto.workOrderId }),
            ...(dto.counterpartyId !== undefined && { counterpartyId: dto.counterpartyId }),
            ...(dto.vehicleId !== undefined && { vehicleId: dto.vehicleId }),
            startAt,
            endAt,
            ...(dto.notes !== undefined && { notes: dto.notes }),
          },
          include: {
            counterparty: {
              select: { firstName: true, lastName: true, companyName: true, phone: true },
            },
            vehicle: { select: { make: true, model: true, licensePlate: true } },
            workOrder: {
              select: {
                number: true,
                counterpartyId: true,
                counterparty: {
                  select: { firstName: true, lastName: true, companyName: true, phone: true },
                },
                vehicle: { select: { make: true, model: true, licensePlate: true } },
              },
            },
          },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    return this.toDto(updated);
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
      throw new BadRequestException('Невірний інтервал часу');
    }
    const excludeFilter = dto.excludeSlotId ? { not: dto.excludeSlotId } : undefined;
    // Bug #397: фільтр workOrderId — щоб виключити слоти що належать поточному
    // наряду під час редагування його планового періоду.
    const excludeWoFilter = dto.excludeWorkOrderId ? { not: dto.excludeWorkOrderId } : undefined;
    // bug-cycle (calendar conflict): findMany без take — порушує §1 (OOM на патологічних
    // даних). Realistic upper bound для часового вікна = декілька десятків.
    const CONFLICT_TAKE = 50;
    // Bug #398: enrichment — щоб фронт міг показати інформативний слот у банері
    // (номер наряду / клієнт / авто), а не лише `${count} слотом`.
    const CONFLICT_SELECT = {
      id: true,
      startAt: true,
      endAt: true,
      liftId: true,
      employeeId: true,
      workOrderId: true,
      vehicleId: true,
      counterpartyId: true,
      parentSlotId: true,
      notes: true,
      status: true,
      type: true,
      counterparty: {
        select: { firstName: true, lastName: true, companyName: true, phone: true },
      },
      vehicle: { select: { make: true, model: true, licensePlate: true } },
      workOrder: {
        select: {
          number: true,
          counterpartyId: true,
          counterparty: {
            select: { firstName: true, lastName: true, companyName: true, phone: true },
          },
          vehicle: { select: { make: true, model: true, licensePlate: true } },
        },
      },
    } as const;

    const [liftSlots, empSlots] = await Promise.all([
      dto.liftId
        ? this.prisma.calendarSlot.findMany({
            where: {
              orgId,
              liftId: dto.liftId,
              deletedAt: null,
              id: excludeFilter,
              workOrderId: excludeWoFilter,
              startAt: { lt: endAt },
              endAt: { gt: startAt },
            },
            select: CONFLICT_SELECT,
            take: CONFLICT_TAKE,
          })
        : Promise.resolve([]),
      dto.employeeId
        ? this.prisma.calendarSlot.findMany({
            where: {
              orgId,
              employeeId: dto.employeeId,
              deletedAt: null,
              id: excludeFilter,
              workOrderId: excludeWoFilter,
              startAt: { lt: endAt },
              endAt: { gt: startAt },
            },
            select: CONFLICT_SELECT,
            take: CONFLICT_TAKE,
          })
        : Promise.resolve([]),
    ]);

    const seen = new Set<string>();
    const allSlots = [...liftSlots, ...empSlots].filter(s => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });

    // Bug #398: використовуємо спільний toDto з повним enrichment, щоб клієнт міг
    // показати корисні дані у банері (номер наряду / клієнт / авто), а не лише
    // підрахунок. CalendarSlotResponseDto уже декларує ці optional-поля.
    return {
      liftConflict: liftSlots.length > 0,
      employeeConflict: empSlots.length > 0,
      anyConflict: allSlots.length > 0,
      conflictSlots: allSlots.map(s => this.toDto(s)),
    };
  }

  async removeSlot(orgId: string, id: string): Promise<void> {
    // Race-safe 1-RTT soft delete via updateMany — compound where (id+orgId+deletedAt:null)
    // блокує double-delete race. Той самий патерн що 8 інших remove() сервісів (cycle 1).
    const result = await this.prisma.calendarSlot.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Слот не знайдено');
  }

  private kyivOffsetMs(d: Date): number {
    // Returns Kyiv UTC offset in ms (e.g. +3h = 10800000) using Intl singleton
    const utcHour = new Date(d).getUTCHours();
    const kyivHour = parseInt(KYIV_HOUR_FMT.format(d), 10);
    return ((kyivHour - utcHour + 24) % 24) * 3600000;
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
      startAt: slot.startAt,
      endAt: slot.endAt,
      notes: slot.notes ?? null,
      status: slot.status,
      type: slot.type,
      workOrderNumber: slot.workOrder?.number,
      counterpartyId,
      counterpartyName,
      cpPhone,
      vehicleSummary,
      vehiclePlate,
    };
  }
}
