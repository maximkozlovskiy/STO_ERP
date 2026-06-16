import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CreateBookingRequestDto,
  BookingRequestResponseDto,
  AvailabilitySlotDto,
} from './booking.dto';

// Module-level Intl singleton — `.toLocaleDateString('uk-UA')` allocates a new formatter
// per call. Booking create runs on every public widget submit → hoist.
const UA_DATE_FMT = new Intl.DateTimeFormat('uk-UA');

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Bug #506: route booking SMS through NotificationsService.send() — single source
    // of truth for branchSettings provider/apiKey + NotificationTemplate body. Previously
    // smsQueue.add() bypassed template resolve and pushed `{ templateCode, params }` —
    // SmsProcessor.process() saw provider=undefined → silent skip ("Невідомий SMS-провайдер").
    private readonly notifications: NotificationsService,
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

    // Parallel: lifts, busy slots, branch settings, booked requests, optional work durations.
    const [lifts, busyCalendarSlots, branchSettings, bookedSlots, works] = await Promise.all([
      this.prisma.lift.findMany({
        where: { orgId, deletedAt: null, zone: { branchId } },
        select: { id: true, name: true },
        take: 50,
      }),
      this.prisma.calendarSlot.findMany({
        where: { orgId, startAt: { gte: dayStart, lte: dayEnd }, deletedAt: null },
        select: { liftId: true, startAt: true, endAt: true },
        take: 500,
      }),
      this.prisma.branchSettings.findUnique({
        where: { branchId },
        select: {
          workStartTime: true,
          workEndTime: true,
          slotDurationMinutes: true,
          workDays: true,
        },
      }),
      // Also block slots already taken by confirmed booking requests on this day.
      this.prisma.bookingRequest.findMany({
        where: {
          orgId,
          branchId,
          status: 'CONFIRMED',
          requestedDate: { gte: dayStart, lte: dayEnd },
          deletedAt: null,
        },
        select: { requestedDate: true },
        take: 200,
      }),
      serviceIds?.length
        ? this.prisma.work.findMany({
            where: { id: { in: serviceIds }, orgId, deletedAt: null },
            select: { normoHours: true },
            take: 20,
          })
        : Promise.resolve([] as Array<{ normoHours: number | null }>),
    ]);

    // Read working hours from BranchSettings (or fall back to defaults).
    const workStart = branchSettings?.workStartTime ?? '09:00';
    const workEnd = branchSettings?.workEndTime ?? '18:00';
    const [startH, startM] = workStart.split(':').map(Number);
    const [endH, endM] = workEnd.split(':').map(Number);
    const startLimitMinutes = startH * 60 + startM;
    const endLimitMinutes = endH * 60 + endM;

    // slotDurationMinutes from settings (default 30 for booking widget step size).
    const stepMinutes = branchSettings?.slotDurationMinutes ?? 30;

    // Check if the requested date is a working day (1=Mon … 7=Sun, ISO weekday).
    const workDaysRaw = branchSettings?.workDays;
    const workDays: number[] = Array.isArray(workDaysRaw)
      ? (workDaysRaw as number[])
      : [1, 2, 3, 4, 5];
    const requestedDayOfWeek = new Date(`${date}T12:00:00.000${offset}`).getDay();
    // JS getDay(): 0=Sun,1=Mon,...,6=Sat → convert to ISO weekday (1=Mon,7=Sun)
    const isoDay = requestedDayOfWeek === 0 ? 7 : requestedDayOfWeek;
    if (!workDays.includes(isoDay)) return [];

    // Calculate duration from requested services (falls back to stepMinutes).
    let totalMinutes = stepMinutes;
    if (works.length) {
      const totalHours = works.reduce((sum, w) => sum + Number(w.normoHours ?? 1), 0);
      totalMinutes = Math.ceil(totalHours * 60);
    }

    // Build set of times already taken by confirmed booking requests (HH:MM strings).
    // BookingRequest doesn't track liftId — block all lifts for that time.
    const bookedTimes = new Set(
      bookedSlots.map(b => {
        const d = new Date(b.requestedDate);
        const h = String(d.getUTCHours()).padStart(2, '0');
        const m = String(d.getUTCMinutes()).padStart(2, '0');
        return `${h}:${m}`;
      }),
    );

    // Generate unique time slots across all lifts.
    // UI shows times — user doesn't pick a specific lift; system assigns on confirm.
    // Slot is available if AT LEAST ONE lift is free at that time.
    const timeSlots: Map<string, AvailabilitySlotDto> = new Map();

    for (
      let minutes = startLimitMinutes;
      minutes + totalMinutes <= endLimitMinutes;
      minutes += stepMinutes
    ) {
      const hour = Math.floor(minutes / 60);
      const min = minutes % 60;
      const startKyiv = `${date}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00.000${offset}`;
      const slotStart = new Date(startKyiv);
      const slotEnd = new Date(slotStart.getTime() + totalMinutes * 60_000);
      const timeKey = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;

      // Skip times already booked via BookingRequest.
      if (bookedTimes.has(timeKey)) continue;

      // Find any free lift for this time window.
      const freeLift = lifts.find(lift => {
        return !busyCalendarSlots.some(
          b =>
            b.liftId === lift.id && new Date(b.startAt) < slotEnd && new Date(b.endAt) > slotStart,
        );
      });

      if (freeLift) {
        timeSlots.set(timeKey, {
          startAt: slotStart.toISOString(),
          endAt: slotEnd.toISOString(),
          liftId: freeLift.id,
          liftName: freeLift.name,
          available: true,
        });
      }
    }

    return Array.from(timeSlots.values());
  }

  async create(orgId: string, dto: CreateBookingRequestDto): Promise<BookingRequestResponseDto> {
    // Bug #252: cross-tenant FK guard for poly-array `serviceIds`. Without this,
    // public endpoint /booking/request can store work-IDs з ЧУЖОЇ org (Postgres
    // text[] не FK, Prisma не валідує) → cross-tenant linkage у заявці. Parallel
    // з branch-guard бо обидва незалежні (різні таблиці).
    const [branch, serviceCount] = await Promise.all([
      // sto-optimize: only branch.name used for SMS template — narrow projection.
      this.prisma.garageBranch.findFirst({
        where: { id: dto.branchId, orgId, deletedAt: null },
        select: { id: true, name: true },
      }),
      dto.serviceIds?.length
        ? this.prisma.work.count({
            where: { id: { in: dto.serviceIds }, orgId, deletedAt: null },
          })
        : Promise.resolve(0),
    ]);
    if (!branch) throw new NotFoundException('Філію не знайдено');
    if (dto.serviceIds?.length && serviceCount !== dto.serviceIds.length) {
      throw new BadRequestException('Деякі послуги не знайдено');
    }

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

    // Bug #506: SMS confirmation via NotificationsService.send() — резолвить branchSettings
    // (provider/apiKey/senderName) + NotificationTemplate.body, рендерить шаблон і кладе
    // справжній SendSmsJob shape у queue. Non-blocking: помилка резолву (SMS не налаштовано
    // на branch або шаблону немає) логується, але бронювання залишається.
    // attempts=10 (offline-first) уже виставляється всередині `sendWithConfig`.
    this.notifications
      .send(orgId, 'BOOKING_CONFIRMATION', {
        branchId: dto.branchId,
        phone: dto.clientPhone,
        clientName: dto.clientName,
        date: UA_DATE_FMT.format(new Date(dto.requestedDate)),
        branchName: branch.name,
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `Booking SMS notification failed: ${err instanceof Error ? err.message : err}`,
        ),
      );

    return this.toDto(req);
  }

  async findAll(
    orgId: string,
    filters?: { date?: string; status?: string },
  ): Promise<{ items: BookingRequestResponseDto[]; total: number }> {
    const where: Prisma.BookingRequestWhereInput = {
      orgId,
      deletedAt: null,
    };
    if (filters?.status) where.status = filters.status;
    if (filters?.date) {
      const offset = this.kyivOffsetForDate(filters.date);
      where.requestedDate = {
        gte: new Date(`${filters.date}T00:00:00.000${offset}`),
        lte: new Date(`${filters.date}T23:59:59.999${offset}`),
      };
    }
    const [items, total] = await Promise.all([
      this.prisma.bookingRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { branch: { select: { name: true } } },
      }),
      this.prisma.bookingRequest.count({ where }),
    ]);
    return { items: items.map(r => this.toDto(r)), total };
  }

  async confirm(orgId: string, id: string): Promise<BookingRequestResponseDto> {
    // Defense-in-depth: scope by orgId у where (sto-review pattern 2026-05-30
    // soft-delete update without orgId). updateMany is atomic on the compound key.
    const result = await this.prisma.bookingRequest.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { status: 'CONFIRMED' },
    });
    if (result.count === 0) throw new NotFoundException('Заявку не знайдено');
    // Bug #276: post-update fetch має включати branch relation — без цього confirm()
    // повертає BookingRequestResponseDto з branchName=null навіть якщо філія є.
    // toDto() читає r.branch?.name; findFirstOrThrow без include → r.branch=undefined.
    // Контракт DTO декларує branchName — клієнт може очікувати рендер у success-toast.
    const updated = await this.prisma.bookingRequest.findFirstOrThrow({
      where: { id, orgId },
      include: { branch: { select: { name: true } } },
    });
    return this.toDto(updated);
  }

  async cancel(orgId: string, id: string): Promise<void> {
    // Defense-in-depth: scope by orgId у where (sto-review pattern 2026-05-30
    // soft-delete update without orgId). Cancel is idempotent — повторний DELETE
    // на вже-скасованому записі поверне 404 (count === 0 бо deletedAt != null).
    const result = await this.prisma.bookingRequest.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { status: 'CANCELLED', deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Заявку не знайдено');
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
    branch?: { name: string } | null;
  }): BookingRequestResponseDto {
    return {
      id: r.id,
      status: r.status,
      clientName: r.clientName,
      clientPhone: r.clientPhone,
      requestedDate: r.requestedDate.toISOString(),
      branchId: r.branchId,
      branchName: r.branch?.name ?? null,
      notes: r.notes ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
