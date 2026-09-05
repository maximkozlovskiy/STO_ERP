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

// DST-safe formatter to produce Kyiv-local "HH:MM" key from any Date.
// getUTCHours() gives wrong slot on DST boundary: у літо 09:00 Kyiv (06:00Z) давав ключ
// '06:00' замість '09:00' → блокування підтверджених бронювань ніколи не спрацьовувало
// (slot keys будуються з BranchSettings.workStartTime у Kyiv-локальному часі).
// en-GB локаль гарантовано emits "HH:MM" 24-годинний padded формат.
const KYIV_HM_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Kyiv',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// ISO weekday у Kyiv TZ (1=Mon..7=Sun) — для перевірки workDays при create().
// 'en-GB' з weekday: 'short' дає "Mon"/"Tue"/.../"Sun".
const KYIV_WEEKDAY_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Kyiv',
  weekday: 'short',
});

const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Route booking SMS through NotificationsService.send() — single source of truth for
    // branchSettings provider/apiKey + NotificationTemplate body. Direct smsQueue.add() bypasses
    // template resolve → SmsProcessor.process() sees provider=undefined → silent skip.
    private readonly notifications: NotificationsService,
  ) {}

  /**
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
   * Working hours are LOCAL to Europe/Kyiv, not UTC. Use `+02:00`/`+03:00` ISO
   * offset depending on DST so slots are produced in real Kyiv time. Derive the
   * offset from a `toLocaleString` round-trip on the requested date to handle
   * DST transition days correctly.
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
    // Day boundaries must be Kyiv-local, not UTC, otherwise a slot
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
    // Key MUST be Kyiv-local (DST-aware): `getUTCHours()` давав зміщений ключ
    // ('06:00' замість '09:00' у літо) → blocking ніколи не спрацьовував.
    // Slot generation нижче формує `timeKey` з Kyiv-локальних `startLimitMinutes`
    // (на основі `BranchSettings.workStartTime`), тому ключі повинні бути в одній TZ.
    const bookedTimes = new Set(
      bookedSlots.map(b => KYIV_HM_FMT.format(new Date(b.requestedDate))),
    );

    // sto-optimize: pre-bucket busy slots by liftId + pre-parse Date once per slot.
    // Раніше внутрішній цикл був O(timeSlots × lifts × busySlots) — для 20 timeslots
    // × 50 lifts × 500 busy slots = 500_000 операцій на запит. Тепер:
    // (1) Map<liftId, ParsedSlot[]> будуємо ОДИН раз → O(B) startup
    // (2) `new Date(b.startAt)` парситься ОДИН раз у startMs (number), не на кожній
    //     ітерації outer-loop (без cache це було N × B `new Date()` allocations).
    // Outer loop стає O(timeSlots × lifts × avg(B/L)).
    const busyByLift = new Map<string, { startMs: number; endMs: number }[]>();
    for (const b of busyCalendarSlots) {
      // CalendarSlot.liftId nullable (unassigned slots). Пропускаємо — вони не
      // блокують конкретний lift, лише захаращують список.
      if (!b.liftId) continue;
      const parsed = {
        startMs: new Date(b.startAt).getTime(),
        endMs: new Date(b.endAt).getTime(),
      };
      const arr = busyByLift.get(b.liftId);
      if (arr) arr.push(parsed);
      else busyByLift.set(b.liftId, [parsed]);
    }

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
      const slotStartMs = slotStart.getTime();
      const slotEndMs = slotStartMs + totalMinutes * 60_000;
      const timeKey = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;

      // Skip times already booked via BookingRequest.
      if (bookedTimes.has(timeKey)) continue;

      // Find any free lift for this time window — O(1) bucket lookup + linear scan
      // лише за слотами цього lift (не всіх 500). Числове порівняння (Ms) — без
      // `new Date()` allocations усередині гарячого циклу.
      const freeLift = lifts.find(lift => {
        const busy = busyByLift.get(lift.id);
        if (!busy) return true;
        for (const p of busy) {
          if (p.startMs < slotEndMs && p.endMs > slotStartMs) return false;
        }
        return true;
      });

      if (freeLift) {
        timeSlots.set(timeKey, {
          startAt: slotStart.toISOString(),
          endAt: new Date(slotEndMs).toISOString(),
          liftId: freeLift.id,
          liftName: freeLift.name,
          available: true,
        });
      }
    }

    return Array.from(timeSlots.values());
  }

  async create(orgId: string, dto: CreateBookingRequestDto): Promise<BookingRequestResponseDto> {
    // Cross-tenant FK guard for poly-array `serviceIds`: public endpoint /booking/request
    // can store work-IDs з ЧУЖОЇ org (Postgres text[] не FK, Prisma не валідує) →
    // cross-tenant linkage у заявці.
    // BranchSettings fetch for server-side validation of working hours — backend cannot
    // trust that the public widget always called /availability before submit (curl bypass).
    const [branch, serviceCount, branchSettings] = await Promise.all([
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
      this.prisma.branchSettings.findUnique({
        where: { branchId: dto.branchId },
        select: { workStartTime: true, workEndTime: true, workDays: true },
      }),
    ]);
    if (!branch) throw new NotFoundException('Філію не знайдено');
    if (dto.serviceIds?.length && serviceCount !== dto.serviceIds.length) {
      throw new BadRequestException('Деякі послуги не знайдено');
    }

    // Server-side guard для working hours. У Kyiv-локальній TZ.
    const requestedAt = new Date(dto.requestedDate);
    if (Number.isNaN(requestedAt.getTime())) {
      throw new BadRequestException('Невірний формат дати');
    }
    // CAL-H2: public widget must not accept a booking in the past. Without this the
    // widget (or a curl bypass) can create requests for yesterday, cluttering the
    // reception queue and firing an SMS for a date that already passed.
    // Compared as absolute instants — Date already carries the client-supplied offset.
    if (requestedAt.getTime() < Date.now()) {
      throw new BadRequestException('Дата запису не може бути в минулому');
    }
    const workStart = branchSettings?.workStartTime ?? '09:00';
    const workEnd = branchSettings?.workEndTime ?? '18:00';
    const workDaysRaw = branchSettings?.workDays;
    const workDays: number[] = Array.isArray(workDaysRaw)
      ? (workDaysRaw as number[])
      : [1, 2, 3, 4, 5];
    const weekdayShort = KYIV_WEEKDAY_FMT.format(requestedAt);
    const isoWeekday = WEEKDAY_TO_ISO[weekdayShort] ?? 0;
    if (!workDays.includes(isoWeekday)) {
      throw new BadRequestException('Запит на неробочий день');
    }
    const requestedHHMM = KYIV_HM_FMT.format(requestedAt);
    if (requestedHHMM < workStart || requestedHHMM >= workEnd) {
      throw new BadRequestException(`Час поза робочими годинами (${workStart}–${workEnd})`);
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

    // SMS confirmation via NotificationsService.send() — резолвить branchSettings
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

  async confirm(orgId: string, id: string, slotId?: string): Promise<BookingRequestResponseDto> {
    // CAL-H3/H4 (conservative slice): a confirmed BookingRequest currently blocks the requested
    // HH:MM across ALL lifts (getAvailability() blocks by time, not by liftId — BookingRequest has
    // no liftId column). The full fix — materialise a CalendarSlot on a concrete lift at confirm
    // time and free the other lifts — needs a schema change (BookingRequest→liftId / a link to the
    // created slot) and is out of scope for a non-breaking patch.
    // TODO(CAL-H3/H4): on confirm, create a CalendarSlot(status=BOOKED) on the chosen lift+time from
    //   `slotId` and persist the link, so only that lift is occupied instead of the whole time band.
    // Conservative part we CAN do safely: if a caller passes `slotId`, validate it is a real,
    // non-deleted slot in THIS org (rejects cross-tenant / stale slot ids) before confirming —
    // no behaviour change when `slotId` is omitted (current controller path).
    if (slotId) {
      const slot = await this.prisma.calendarSlot.findFirst({
        where: { id: slotId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!slot) throw new NotFoundException('Слот не знайдено');
    }

    // Defense-in-depth: scope by orgId у where (sto-review pattern 2026-05-30
    // soft-delete update without orgId). updateMany is atomic on the compound key.
    const result = await this.prisma.bookingRequest.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { status: 'CONFIRMED' },
    });
    if (result.count === 0) throw new NotFoundException('Заявку не знайдено');
    // Post-update fetch must include branch relation — without it confirm() returns
    // BookingRequestResponseDto with branchName=null even when branch exists.
    // toDto() reads r.branch?.name; findFirstOrThrow without include → r.branch=undefined.
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
