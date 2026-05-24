import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCalendarSlotDto, CalendarSlotResponseDto } from './calendar.dto';

@Injectable()
export class CalendarService {
  constructor(private readonly prisma: PrismaService) {}

  async findSlots(orgId: string, date: string, branchId?: string): Promise<CalendarSlotResponseDto[]> {
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
    } = {
      orgId,
      deletedAt: null,
      startAt: { gte: start },
      endAt: { lte: end },
    };
    if (branchId) where.lift = { zone: { branchId, orgId } };

    const slots = await this.prisma.calendarSlot.findMany({
      where,
      orderBy: { startAt: 'asc' },
      include: { workOrder: { select: { number: true } } },
      take: 500,
    });

    return slots.map(item => this.toDto(item));
  }

  async createSlot(orgId: string, dto: CreateCalendarSlotDto): Promise<CalendarSlotResponseDto> {
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);

    if (endAt <= startAt) throw new BadRequestException('Час завершення має бути після початку');

    // Validate FK ownership to prevent cross-tenant injection
    if (dto.liftId) {
      const lift = await this.prisma.lift.findFirst({ where: { id: dto.liftId, orgId, deletedAt: null } });
      if (!lift) throw new NotFoundException('Підйомник не знайдено');
    }
    if (dto.employeeId) {
      const employee = await this.prisma.employee.findFirst({ where: { id: dto.employeeId, orgId, deletedAt: null } });
      if (!employee) throw new NotFoundException('Співробітника не знайдено');
    }
    if (dto.workOrderId) {
      const workOrder = await this.prisma.workOrder.findFirst({ where: { id: dto.workOrderId, orgId, deletedAt: null } });
      if (!workOrder) throw new NotFoundException('Наряд не знайдено');
    }

    const slot = await this.prisma.$transaction(async (tx) => {
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
        startAt,
        endAt,
        notes: dto.notes ?? null,
      },
      include: { workOrder: { select: { number: true } } },
    });
    });

    return this.toDto(slot);
  }

  async removeSlot(orgId: string, id: string): Promise<void> {
    const slot = await this.prisma.calendarSlot.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!slot) throw new NotFoundException('Слот не знайдено');
    await this.prisma.calendarSlot.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
  }

  private kyivOffsetMs(d: Date): number {
    // Returns Kyiv UTC offset in ms (e.g. +3h = 10800000) using Intl
    const utcStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false }).format(d);
    const utcHour = new Date(d).getUTCHours();
    const kyivHour = parseInt(utcStr, 10);
    return ((kyivHour - utcHour + 24) % 24) * 3600000;
  }

  private toDto(slot: {
    id: string; liftId: string | null; employeeId: string | null; workOrderId: string | null;
    startAt: Date; endAt: Date; notes: string | null;
    workOrder: { number: string } | null;
  }): CalendarSlotResponseDto {
    return {
      id: slot.id,
      liftId: slot.liftId ?? null,
      employeeId: slot.employeeId ?? null,
      workOrderId: slot.workOrderId ?? null,
      startAt: slot.startAt,
      endAt: slot.endAt,
      notes: slot.notes ?? null,
      workOrderNumber: slot.workOrder?.number,
    };
  }
}
