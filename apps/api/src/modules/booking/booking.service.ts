import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateBookingRequestDto,
  BookingRequestResponseDto,
  AvailabilitySlotDto,
} from './booking.dto';

@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('sms') private readonly smsQueue: Queue,
  ) {}

  /**
   * Bug #112: Public booking widget needs branch info without auth.
   * Single source of truth for branch lookup — soft-deleted branches must NEVER
   * leak to public booking, otherwise customers see slots for a closed location.
   */
  async findBranchForBooking(
    branchId: string,
  ): Promise<{ id: string; orgId: string; name: string } | null> {
    return this.prisma.garageBranch.findFirst({
      where: { id: branchId, deletedAt: null },
      select: { id: true, orgId: true, name: true },
    });
  }

  /** Public list of branches for booking widget (no auth required). */
  async listBranchesForBooking(): Promise<
    { id: string; name: string; address: string | null; orgId: string }[]
  > {
    return this.prisma.garageBranch.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, address: true, orgId: true },
      orderBy: { name: 'asc' },
      take: 100,
    });
  }

  /**
   * Bug #113: Working hours are LOCAL to Europe/Kyiv (09:00–18:00 Kyiv time),
   * not UTC. Use `+02:00`/`+03:00` ISO offset depending on DST so slots are
   * produced in real Kyiv time. We derive the offset from a `toLocaleString`
   * round-trip on the requested date to handle DST transition days correctly.
   */
  private kyivOffsetForDate(date: string): string {
    // Convert the date's noon-UTC moment to Kyiv local time and read the offset.
    // Using noon (not midnight) avoids issues with DST transition at 03:00 local.
    const probe = new Date(`${date}T12:00:00.000Z`);
    const kyivStr = probe.toLocaleString('en-US', { timeZone: 'Europe/Kyiv', hour12: false });
    const kyivDate = new Date(kyivStr + ' UTC');
    const offsetMin = (kyivDate.getTime() - probe.getTime()) / 60_000;
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const h = String(Math.floor(abs / 60)).padStart(2, '0');
    const m = String(abs % 60).padStart(2, '0');
    return `${sign}${h}:${m}`;
  }

  async getAvailability(
    orgId: string,
    branchId: string,
    date: string,
    serviceIds?: string[],
  ): Promise<AvailabilitySlotDto[]> {
    // Bug #113: day boundaries must be Kyiv-local, not UTC, otherwise a slot
    // requested for "2026-05-27 in Kyiv" would search a misaligned UTC window.
    const offset = this.kyivOffsetForDate(date);
    const dayStart = new Date(`${date}T00:00:00.000${offset}`);
    const dayEnd = new Date(`${date}T23:59:59.999${offset}`);

    // Parallel: all three reads (lifts in branch, busy slots, optional work durations)
    // are independent — collapses 2-3 sequential RTT into one.
    const [lifts, busySlots, works] = await Promise.all([
      this.prisma.lift.findMany({
        where: { orgId, deletedAt: null, zone: { branchId } },
        take: 50,
      }),
      this.prisma.calendarSlot.findMany({
        where: { orgId, startAt: { gte: dayStart, lte: dayEnd }, deletedAt: null },
        select: { liftId: true, startAt: true, endAt: true },
        take: 500,
      }),
      serviceIds?.length
        ? this.prisma.work.findMany({
            where: { id: { in: serviceIds }, orgId, deletedAt: null },
            select: { normoHours: true },
            take: 20,
          })
        : Promise.resolve([] as Array<{ normoHours: number | null }>),
    ]);

    // Calculate duration from requested services
    let totalMinutes = 60; // default 1 hour
    if (works.length) {
      const totalHours = works.reduce((sum, w) => sum + Number(w.normoHours ?? 1), 0);
      totalMinutes = Math.ceil(totalHours * 60);
    }

    // Working hours 09:00–18:00 LOCAL (Europe/Kyiv), 30-min steps.
    // We construct timestamps in Kyiv local with explicit ISO offset.
    const endLimitMinutes = 18 * 60; // 18:00 Kyiv local
    const slots: AvailabilitySlotDto[] = [];
    for (const lift of lifts) {
      for (let hour = 9; hour < 18; hour++) {
        for (const min of [0, 30]) {
          const startKyiv = `${date}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00.000${offset}`;
          const slotStart = new Date(startKyiv);
          const slotEnd = new Date(slotStart.getTime() + totalMinutes * 60_000);
          // Reject slots that would end after 18:00 Kyiv local.
          const endMinutes = hour * 60 + min + totalMinutes;
          if (endMinutes > endLimitMinutes) continue;

          const isBusy = busySlots.some(
            b =>
              b.liftId === lift.id &&
              new Date(b.startAt) < slotEnd &&
              new Date(b.endAt) > slotStart,
          );

          slots.push({
            startAt: slotStart.toISOString(),
            endAt: slotEnd.toISOString(),
            liftId: lift.id,
            liftName: lift.name,
            available: !isBusy,
          });
        }
      }
    }
    return slots;
  }

  async create(orgId: string, dto: CreateBookingRequestDto): Promise<BookingRequestResponseDto> {
    const branch = await this.prisma.garageBranch.findFirst({
      where: { id: dto.branchId, orgId, deletedAt: null },
    });
    if (!branch) throw new NotFoundException('Філію не знайдено');

    const req = await this.prisma.bookingRequest.create({
      data: {
        orgId,
        branchId: dto.branchId,
        clientName: dto.clientName,
        clientPhone: dto.clientPhone,
        requestedDate: new Date(dto.requestedDate),
        serviceIds: dto.serviceIds ?? [],
        notes: dto.notes ?? null,
      },
    });

    // SMS confirmation via BullMQ (offline-first)
    await this.smsQueue.add(
      'send-sms',
      {
        orgId,
        phone: dto.clientPhone,
        templateCode: 'BOOKING_CONFIRMATION',
        params: {
          clientName: dto.clientName,
          date: new Date(dto.requestedDate).toLocaleDateString('uk-UA'),
          branchName: branch.name,
        },
      },
      // Offline-first SMS retry: 10 attempts (skill rule), exponential backoff 60s start
      { attempts: 10, backoff: { type: 'exponential', delay: 60_000 } },
    );

    return this.toDto(req);
  }

  async findAll(orgId: string): Promise<{ items: BookingRequestResponseDto[]; total: number }> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.bookingRequest.findMany({
        where: { orgId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.bookingRequest.count({ where: { orgId, deletedAt: null } }),
    ]);
    return { items: items.map(r => this.toDto(r)), total };
  }

  async confirm(orgId: string, id: string): Promise<BookingRequestResponseDto> {
    const req = await this.prisma.bookingRequest.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!req) throw new NotFoundException('Заявку не знайдено');
    const updated = await this.prisma.bookingRequest.update({
      where: { id },
      data: { status: 'CONFIRMED' },
    });
    return this.toDto(updated);
  }

  async cancel(orgId: string, id: string): Promise<void> {
    const req = await this.prisma.bookingRequest.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!req) throw new NotFoundException('Заявку не знайдено');
    await this.prisma.bookingRequest.update({
      where: { id },
      data: { status: 'CANCELLED', deletedAt: new Date() },
    });
  }

  private toDto(r: {
    id: string;
    status: string;
    clientName: string;
    clientPhone: string;
    requestedDate: Date;
    branchId: string;
    notes: string | null;
    createdAt: Date;
  }): BookingRequestResponseDto {
    return {
      id: r.id,
      status: r.status,
      clientName: r.clientName,
      clientPhone: r.clientPhone,
      requestedDate: r.requestedDate.toISOString(),
      branchId: r.branchId,
      notes: r.notes ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
