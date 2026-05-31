import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { CalendarSlotStatus, CalendarSlotType } from '@prisma/client';
import { formatPersonName } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateCalendarSlotDto,
  UpdateCalendarSlotDto,
  CalendarSlotResponseDto,
} from './calendar.dto';

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
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        workOrder: {
          select: {
            number: true,
            counterpartyId: true,
            counterparty: { select: { firstName: true, lastName: true, companyName: true } },
          },
        },
      },
      take: 500,
    });

    return slots.map(item => this.toDto(item));
  }

  async createSlot(orgId: string, dto: CreateCalendarSlotDto): Promise<CalendarSlotResponseDto> {
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);

    if (endAt <= startAt) throw new BadRequestException('Час завершення має бути після початку');

    // Validate FK ownership to prevent cross-tenant injection — independent checks run in parallel
    const [lift, employee, workOrder, counterparty] = await Promise.all([
      dto.liftId
        ? this.prisma.lift.findFirst({ where: { id: dto.liftId, orgId, deletedAt: null } })
        : Promise.resolve(null),
      dto.employeeId
        ? this.prisma.employee.findFirst({ where: { id: dto.employeeId, orgId, deletedAt: null } })
        : Promise.resolve(null),
      dto.workOrderId
        ? this.prisma.workOrder.findFirst({
            where: { id: dto.workOrderId, orgId, deletedAt: null },
          })
        : Promise.resolve(null),
      dto.counterpartyId
        ? this.prisma.counterparty.findFirst({
            where: { id: dto.counterpartyId, orgId, deletedAt: null },
          })
        : Promise.resolve(null),
    ]);
    if (dto.liftId && !lift) throw new NotFoundException('Підйомник не знайдено');
    if (dto.employeeId && !employee) throw new NotFoundException('Співробітника не знайдено');
    if (dto.workOrderId && !workOrder) throw new NotFoundException('Наряд не знайдено');
    if (dto.counterpartyId && !counterparty) throw new NotFoundException('Клієнта не знайдено');

    const slot = await this.prisma.$transaction(
      async tx => {
        if (dto.liftId) {
          const conflict = await tx.calendarSlot.findFirst({
            where: {
              orgId,
              liftId: dto.liftId,
              deletedAt: null,
              OR: [{ startAt: { lt: endAt }, endAt: { gt: startAt } }],
            },
          });
          if (conflict) throw new BadRequestException('Підйомник вже зайнятий на цей час');
        }
        if (dto.employeeId) {
          const empConflict = await tx.calendarSlot.findFirst({
            where: {
              orgId,
              employeeId: dto.employeeId,
              deletedAt: null,
              OR: [{ startAt: { lt: endAt }, endAt: { gt: startAt } }],
            },
          });
          if (empConflict) throw new BadRequestException('Співробітник вже зайнятий на цей час');
        }

        return tx.calendarSlot.create({
          data: {
            orgId,
            liftId: dto.liftId ?? null,
            employeeId: dto.employeeId ?? null,
            workOrderId: dto.workOrderId ?? null,
            counterpartyId: dto.counterpartyId ?? null,
            startAt,
            endAt,
            notes: dto.notes ?? null,
            status: dto.status ?? CalendarSlotStatus.BOOKED,
            type: dto.type ?? CalendarSlotType.WORK,
          },
          include: {
            counterparty: { select: { firstName: true, lastName: true, companyName: true } },
            workOrder: {
              select: {
                number: true,
                counterpartyId: true,
                counterparty: { select: { firstName: true, lastName: true, companyName: true } },
              },
            },
          },
        });
        // Bug #130: explicit 5s timeout (2 conflict checks + 1 create — well below default).
      },
      { timeout: 5_000 },
    );

    return this.toDto(slot);
  }

  async updateSlot(
    orgId: string,
    id: string,
    dto: UpdateCalendarSlotDto,
  ): Promise<CalendarSlotResponseDto> {
    // Existing slot + independent FK ownership checks run in parallel; error priority preserved below
    const checkLift = dto.liftId !== undefined && dto.liftId !== null;
    const checkEmployee = dto.employeeId !== undefined && dto.employeeId !== null;
    const checkWorkOrder = dto.workOrderId !== undefined && dto.workOrderId !== null;
    const checkCounterparty = dto.counterpartyId !== undefined && dto.counterpartyId !== null;
    const [existing, lift, employee, workOrder, counterparty] = await Promise.all([
      this.prisma.calendarSlot.findFirst({ where: { id, orgId, deletedAt: null } }),
      checkLift
        ? this.prisma.lift.findFirst({ where: { id: dto.liftId!, orgId, deletedAt: null } })
        : Promise.resolve(null),
      checkEmployee
        ? this.prisma.employee.findFirst({ where: { id: dto.employeeId!, orgId, deletedAt: null } })
        : Promise.resolve(null),
      checkWorkOrder
        ? this.prisma.workOrder.findFirst({
            where: { id: dto.workOrderId!, orgId, deletedAt: null },
          })
        : Promise.resolve(null),
      checkCounterparty
        ? this.prisma.counterparty.findFirst({
            where: { id: dto.counterpartyId!, orgId, deletedAt: null },
          })
        : Promise.resolve(null),
    ]);
    if (!existing) throw new NotFoundException('Слот не знайдено');
    if (checkLift && !lift) throw new NotFoundException('Підйомник не знайдено');
    if (checkEmployee && !employee) throw new NotFoundException('Співробітника не знайдено');
    if (checkWorkOrder && !workOrder) throw new NotFoundException('Наряд не знайдено');
    if (checkCounterparty && !counterparty) throw new NotFoundException('Клієнта не знайдено');

    const startAt = dto.startAt ? new Date(dto.startAt) : existing.startAt;
    const endAt = dto.endAt ? new Date(dto.endAt) : existing.endAt;
    if (endAt <= startAt) throw new BadRequestException('Час завершення має бути після початку');

    const liftId = dto.liftId !== undefined ? dto.liftId : existing.liftId;

    const updated = await this.prisma.$transaction(
      async tx => {
        if (liftId) {
          const conflict = await tx.calendarSlot.findFirst({
            where: {
              orgId,
              liftId,
              deletedAt: null,
              NOT: { id },
              OR: [{ startAt: { lt: endAt }, endAt: { gt: startAt } }],
            },
          });
          if (conflict) throw new BadRequestException('Підйомник вже зайнятий на цей час');
        }

        const employeeId = dto.employeeId !== undefined ? dto.employeeId : existing.employeeId;
        if (employeeId) {
          const empConflict = await tx.calendarSlot.findFirst({
            where: {
              orgId,
              employeeId,
              deletedAt: null,
              NOT: { id },
              OR: [{ startAt: { lt: endAt }, endAt: { gt: startAt } }],
            },
          });
          if (empConflict) throw new BadRequestException('Співробітник вже зайнятий на цей час');
        }

        return tx.calendarSlot.update({
          where: { id, orgId },
          data: {
            ...(dto.liftId !== undefined && { liftId: dto.liftId }),
            ...(dto.employeeId !== undefined && { employeeId: dto.employeeId }),
            ...(dto.workOrderId !== undefined && { workOrderId: dto.workOrderId }),
            ...(dto.counterpartyId !== undefined && { counterpartyId: dto.counterpartyId }),
            startAt,
            endAt,
            ...(dto.notes !== undefined && { notes: dto.notes }),
          },
          include: {
            counterparty: { select: { firstName: true, lastName: true, companyName: true } },
            workOrder: {
              select: {
                number: true,
                counterpartyId: true,
                counterparty: { select: { firstName: true, lastName: true, companyName: true } },
              },
            },
          },
        });
      },
      { timeout: 5_000 },
    );

    return this.toDto(updated);
  }

  async removeSlot(orgId: string, id: string): Promise<void> {
    const slot = await this.prisma.calendarSlot.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!slot) throw new NotFoundException('Слот не знайдено');
    await this.prisma.calendarSlot.update({
      where: { id, orgId },
      data: { deletedAt: new Date() },
    });
  }

  private kyivOffsetMs(d: Date): number {
    // Returns Kyiv UTC offset in ms (e.g. +3h = 10800000) using Intl
    const utcStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Kyiv',
      hour: '2-digit',
      hour12: false,
    }).format(d);
    const utcHour = new Date(d).getUTCHours();
    const kyivHour = parseInt(utcStr, 10);
    return ((kyivHour - utcHour + 24) % 24) * 3600000;
  }

  private toDto(slot: {
    id: string;
    liftId: string | null;
    employeeId: string | null;
    workOrderId: string | null;
    counterpartyId?: string | null;
    startAt: Date;
    endAt: Date;
    notes: string | null;
    status: CalendarSlotStatus;
    type: CalendarSlotType;
    workOrder: {
      number: string;
      counterpartyId: string;
      counterparty: {
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
      } | null;
    } | null;
    counterparty?: {
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
    } | null;
  }): CalendarSlotResponseDto {
    const woCp = slot.workOrder?.counterparty;
    const directCp = slot.counterparty;
    const cp = woCp ?? directCp;
    const counterpartyName = cp
      ? formatPersonName(cp.lastName, cp.firstName, cp.companyName) || undefined
      : undefined;

    const counterpartyId = slot.counterpartyId ?? slot.workOrder?.counterpartyId ?? null;

    return {
      id: slot.id,
      liftId: slot.liftId ?? null,
      employeeId: slot.employeeId ?? null,
      workOrderId: slot.workOrderId ?? null,
      startAt: slot.startAt,
      endAt: slot.endAt,
      notes: slot.notes ?? null,
      status: slot.status,
      type: slot.type,
      workOrderNumber: slot.workOrder?.number,
      counterpartyId,
      counterpartyName,
    };
  }
}
