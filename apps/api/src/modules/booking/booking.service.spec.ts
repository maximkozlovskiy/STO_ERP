import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { BookingService } from './booking.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Bug #254: unit-покриття `BookingService.create` + `confirm` + `cancel`.
 * Bug #506: SMS confirmation тепер йде через `NotificationsService.send()`,
 *           а НЕ через прямий `smsQueue.add()`. Spec оновлено щоб перевіряти
 *           правильний event type + payload contract — інакше регресія яка
 *           замінить виклик назад на прямий queue.add({ templateCode, params })
 *           пройде CI зеленою (Bug #507 — попередня spec перевіряла лише
 *           `attempts: 10` у options, не shape job.data).
 *
 * Фокус:
 *   • Cross-tenant FK validation для `serviceIds` (Bug #252 — public endpoint
 *     приймає UUID-и; перевірка кількості через `prisma.work.count` має ловити
 *     foreign IDs).
 *   • Defense-in-depth `updateMany({ id, orgId, deletedAt: null })` у confirm/cancel.
 *   • Branch tenant guard.
 *   • Bug #506: NotificationsService.send('BOOKING_CONFIRMATION', { branchId,
 *     phone, clientName, date, branchName }) — повний payload контракт.
 *
 * Без spec regression у tenant-FK (e.g. видалення count-check під рефактор)
 * пройде CI зеленим — публічний endpoint буде приймати UUID-и з чужих org.
 */
describe('BookingService', () => {
  let service: BookingService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let notifications: any;
  const orgId = 'org-1';
  const branchId = 'branch-1';
  const bookingId = 'booking-1';

  beforeEach(async () => {
    prisma = {
      garageBranch: { findFirst: vi.fn() },
      bookingRequest: {
        create: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
        findFirstOrThrow: vi.fn(),
        findMany: vi.fn(),
      },
      work: { count: vi.fn(), findMany: vi.fn() },
      branchSettings: { findUnique: vi.fn() },
      lift: { findMany: vi.fn() },
      calendarSlot: { findMany: vi.fn() },
    };
    notifications = { send: vi.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({
      providers: [
        BookingService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(BookingService);
  });

  describe('create', () => {
    // CAL-H2: create() тепер відхиляє минулі дати, тому тестові дати мусять бути у
    // МАЙБУТНЬОМУ (інакше happy-path падав би з часом). Обчислюємо наступний робочий/вихідний
    // день динамічно (>=30 днів наперед), зберігаючи Kyiv-локальний час.
    // Bug #514: requestedDate має потрапляти у робоче вікно (09:00..18:00 Kyiv, workDays [1..5]).
    // `12:00` local Kyiv (через `+02:00` зимовий або `+03:00` літній offset нижче) — усередині вікна.
    const kyivOffsetLiteral = (d: Date): string => {
      // "+02:00" або "+03:00" залежно від DST на дату — щоб `12:00` було Kyiv-локальним.
      const str = d.toLocaleString('en-US', { timeZone: 'Europe/Kyiv', hour12: false });
      const offMin = (new Date(str + ' UTC').getTime() - d.getTime()) / 60_000;
      const sign = offMin >= 0 ? '+' : '-';
      const h = String(Math.floor(Math.abs(offMin) / 60)).padStart(2, '0');
      return `${sign}${h}:00`;
    };
    // Наступна дата з ISO-weekday `iso` (1=Mon..7=Sun), щонайменше 30 днів наперед.
    const futureDateForWeekday = (iso: number, hhmm = '12:00'): string => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + 30);
      // рухаємось уперед доки ISO-weekday у Kyiv не збігається
      for (let i = 0; i < 7; i++) {
        const wd = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' })).getDay();
        const isoWd = wd === 0 ? 7 : wd;
        if (isoWd === iso) break;
        d.setUTCDate(d.getUTCDate() + 1);
      }
      const ymd = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(d);
      const probe = new Date(`${ymd}T${hhmm}:00Z`);
      return `${ymd}T${hhmm}:00.000${kyivOffsetLiteral(probe)}`;
    };
    const futureMonday = futureDateForWeekday(1); // робочий день, 12:00 Kyiv
    const futureSunday = futureDateForWeekday(7); // вихідний (workDays [1..5])

    const validDto = {
      branchId,
      clientName: 'Іван Тестовий',
      clientPhone: '+380501234567',
      requestedDate: futureMonday,
    };

    // Helper — mock branchSettings.findUnique з дефолтними робочими годинами.
    const mockDefaultWorkingHours = () =>
      prisma.branchSettings.findUnique.mockResolvedValueOnce({
        workStartTime: '09:00',
        workEndTime: '18:00',
        workDays: [1, 2, 3, 4, 5],
      });

    it('Bug #506: happy path — booking створюється + notifications.send викликано з правильним event+payload', async () => {
      prisma.garageBranch.findFirst.mockResolvedValueOnce({ id: branchId, name: 'Філія 1' });
      prisma.work.count.mockResolvedValueOnce(0);
      mockDefaultWorkingHours();
      prisma.bookingRequest.create.mockResolvedValueOnce({
        id: bookingId,
        status: 'PENDING',
        clientName: validDto.clientName,
        clientPhone: validDto.clientPhone,
        requestedDate: new Date(validDto.requestedDate),
        branchId,
        notes: null,
        createdAt: new Date(),
      });

      const result = await service.create(orgId, validDto);

      expect(prisma.bookingRequest.create).toHaveBeenCalledTimes(1);

      // Bug #506: КРИТИЧНИЙ guard — NotificationsService.send викликано з:
      //   (1) правильним event type 'BOOKING_CONFIRMATION'
      //   (2) branchId (резолвить branchSettings provider/apiKey)
      //   (3) phone (target SMS recipient)
      //   (4) template placeholders: clientName, date, branchName
      // Регресія яка замінить це на прямий smsQueue.add({ templateCode, params })
      // упаде на цей expect — попередня spec пропускала такі регресії.
      expect(notifications.send).toHaveBeenCalledTimes(1);
      expect(notifications.send).toHaveBeenCalledWith(
        orgId,
        'BOOKING_CONFIRMATION',
        expect.objectContaining({
          branchId,
          phone: validDto.clientPhone,
          clientName: validDto.clientName,
          branchName: 'Філія 1',
          date: expect.any(String),
        }),
      );

      expect(result.id).toBe(bookingId);
      expect(result.status).toBe('PENDING');
    });

    it('Bug #506: notifications.send падає → booking не блокується (.catch warn)', async () => {
      prisma.garageBranch.findFirst.mockResolvedValueOnce({ id: branchId, name: 'Філія 1' });
      prisma.work.count.mockResolvedValueOnce(0);
      mockDefaultWorkingHours();
      prisma.bookingRequest.create.mockResolvedValueOnce({
        id: bookingId,
        status: 'PENDING',
        clientName: validDto.clientName,
        clientPhone: validDto.clientPhone,
        requestedDate: new Date(validDto.requestedDate),
        branchId,
        notes: null,
        createdAt: new Date(),
      });
      // SMS template missing or queue down — public booking widget must NOT fail.
      notifications.send.mockRejectedValueOnce(new Error('Redis недоступний'));

      const result = await service.create(orgId, validDto);

      expect(result.id).toBe(bookingId);
      // Booking створений; SMS-помилка ловиться через .catch(warn) — користувач отримує OK.
    });

    it('Bug #252: cross-tenant serviceIds → BadRequestException; bookingRequest НЕ створюється', async () => {
      prisma.garageBranch.findFirst.mockResolvedValueOnce({ id: branchId, name: 'Філія 1' });
      // Запитали 2 UUID, в org існує лише 1 — означає що один з чужої org.
      prisma.work.count.mockResolvedValueOnce(1);
      mockDefaultWorkingHours();

      await expect(
        service.create(orgId, {
          ...validDto,
          serviceIds: [
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Critical: count було викликане з правильним where (orgId + deletedAt: null).
      expect(prisma.work.count).toHaveBeenCalledTimes(1);
      const countArgs = prisma.work.count.mock.calls[0][0];
      expect(countArgs.where.orgId).toBe(orgId);
      expect(countArgs.where.deletedAt).toBe(null);

      // Booking НЕ створюється.
      expect(prisma.bookingRequest.create).not.toHaveBeenCalled();
      expect(notifications.send).not.toHaveBeenCalled();
    });

    it('branch не знайдено (cross-tenant or soft-deleted) → NotFoundException', async () => {
      prisma.garageBranch.findFirst.mockResolvedValueOnce(null);
      prisma.work.count.mockResolvedValueOnce(0);
      mockDefaultWorkingHours();

      await expect(service.create(orgId, validDto)).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.bookingRequest.create).not.toHaveBeenCalled();
      expect(notifications.send).not.toHaveBeenCalled();
    });

    // Bug #514: server-side guard для working hours.
    it('Bug #514: requestedDate у неробочий день (неділя) → BadRequestException; booking НЕ створюється', async () => {
      prisma.garageBranch.findFirst.mockResolvedValueOnce({ id: branchId, name: 'Філія 1' });
      prisma.work.count.mockResolvedValueOnce(0);
      mockDefaultWorkingHours();

      // Майбутня неділя; workDays default [1..5] не включає 7. (CAL-H2: має бути у майбутньому.)
      await expect(
        service.create(orgId, { ...validDto, requestedDate: futureSunday }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.bookingRequest.create).not.toHaveBeenCalled();
      expect(notifications.send).not.toHaveBeenCalled();
    });

    it('Bug #514: requestedDate до workStartTime → BadRequestException', async () => {
      prisma.garageBranch.findFirst.mockResolvedValueOnce({ id: branchId, name: 'Філія 1' });
      prisma.work.count.mockResolvedValueOnce(0);
      mockDefaultWorkingHours();

      // Майбутній робочий день, 06:00 Kyiv — поза [09:00, 18:00). (CAL-H2: у майбутньому.)
      await expect(
        service.create(orgId, {
          ...validDto,
          requestedDate: futureDateForWeekday(1, '06:00'),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.bookingRequest.create).not.toHaveBeenCalled();
    });

    it('Bug #514: requestedDate після workEndTime → BadRequestException', async () => {
      prisma.garageBranch.findFirst.mockResolvedValueOnce({ id: branchId, name: 'Філія 1' });
      prisma.work.count.mockResolvedValueOnce(0);
      mockDefaultWorkingHours();

      // Майбутній робочий день, 19:00 Kyiv — поза [09:00, 18:00). (CAL-H2: у майбутньому.)
      await expect(
        service.create(orgId, {
          ...validDto,
          requestedDate: futureDateForWeekday(1, '19:00'),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.bookingRequest.create).not.toHaveBeenCalled();
    });

    // CAL-H2: public widget (or curl bypass) must not create a booking in the past.
    it('CAL-H2: requestedDate у минулому → BadRequestException; booking НЕ створюється', async () => {
      prisma.garageBranch.findFirst.mockResolvedValueOnce({ id: branchId, name: 'Філія 1' });
      prisma.work.count.mockResolvedValueOnce(0);
      mockDefaultWorkingHours();

      // Явно минула дата (2020) — Monday 12:00, робочі години ОК, але у минулому.
      await expect(
        service.create(orgId, { ...validDto, requestedDate: '2020-06-01T12:00:00+03:00' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.bookingRequest.create).not.toHaveBeenCalled();
      expect(notifications.send).not.toHaveBeenCalled();
    });

    it('Bug #514: fallback workDays [1..5] коли BranchSettings.workDays=null', async () => {
      prisma.garageBranch.findFirst.mockResolvedValueOnce({ id: branchId, name: 'Філія 1' });
      prisma.work.count.mockResolvedValueOnce(0);
      // No BranchSettings row — Mon-Fri default treated as working.
      prisma.branchSettings.findUnique.mockResolvedValueOnce(null);

      prisma.bookingRequest.create.mockResolvedValueOnce({
        id: bookingId,
        status: 'PENDING',
        clientName: validDto.clientName,
        clientPhone: validDto.clientPhone,
        requestedDate: new Date(validDto.requestedDate),
        branchId,
        notes: null,
        createdAt: new Date(),
      });

      // Monday 12:00 Kyiv — within default 09:00-18:00 + Mon-Fri.
      await expect(service.create(orgId, validDto)).resolves.toBeDefined();
    });
  });

  // Bug #511: DST-safe bookedTimes — слот блокується по Kyiv-локальному ключу, не UTC.
  describe('getAvailability — Bug #511', () => {
    it('блокує підтверджене бронювання на 09:00 Kyiv (= 06:00Z у літо) — ключ Kyiv-local', async () => {
      prisma.lift.findMany.mockResolvedValueOnce([{ id: 'lift-1', name: 'Підйомник 1' }]);
      prisma.calendarSlot.findMany.mockResolvedValueOnce([]);
      prisma.branchSettings.findUnique.mockResolvedValueOnce({
        workStartTime: '09:00',
        workEndTime: '18:00',
        slotDurationMinutes: 30,
        workDays: [1, 2, 3, 4, 5],
      });
      // CONFIRMED booking на 2026-06-01 09:00 Kyiv (= 06:00Z в літній DST)
      prisma.bookingRequest.findMany.mockResolvedValueOnce([
        { requestedDate: new Date('2026-06-01T06:00:00.000Z') },
      ]);
      prisma.work.findMany.mockResolvedValueOnce([]);

      const slots = await service.getAvailability(orgId, branchId, '2026-06-01');

      // Слоти не мають включати 09:00 (08:00Z після фіксу не існує бо це поза workStartTime;
      // 09:00 Kyiv = 06:00Z і саме він заблокований).
      const blockedSlot = slots.find(s => s.startAt.startsWith('2026-06-01T06:00'));
      expect(blockedSlot).toBeUndefined();
    });

    it('повертає [] для вихідного дня (workDays не включає неділю)', async () => {
      prisma.lift.findMany.mockResolvedValueOnce([{ id: 'lift-1', name: 'Підйомник 1' }]);
      prisma.calendarSlot.findMany.mockResolvedValueOnce([]);
      prisma.branchSettings.findUnique.mockResolvedValueOnce({
        workStartTime: '09:00',
        workEndTime: '18:00',
        slotDurationMinutes: 30,
        workDays: [1, 2, 3, 4, 5],
      });
      prisma.bookingRequest.findMany.mockResolvedValueOnce([]);
      prisma.work.findMany.mockResolvedValueOnce([]);

      // 2026-06-07 — неділя
      const slots = await service.getAvailability(orgId, branchId, '2026-06-07');
      expect(slots).toEqual([]);
    });

    it('повертає [] якщо немає ліфтів (порожня філія)', async () => {
      prisma.lift.findMany.mockResolvedValueOnce([]);
      prisma.calendarSlot.findMany.mockResolvedValueOnce([]);
      prisma.branchSettings.findUnique.mockResolvedValueOnce({
        workStartTime: '09:00',
        workEndTime: '18:00',
        slotDurationMinutes: 30,
        workDays: [1, 2, 3, 4, 5],
      });
      prisma.bookingRequest.findMany.mockResolvedValueOnce([]);
      prisma.work.findMany.mockResolvedValueOnce([]);

      const slots = await service.getAvailability(orgId, branchId, '2026-06-01');
      expect(slots).toEqual([]);
    });

    it('використовує дефолти 09:00-18:00 + Mon-Fri коли BranchSettings відсутній', async () => {
      prisma.lift.findMany.mockResolvedValueOnce([{ id: 'lift-1', name: 'Підйомник 1' }]);
      prisma.calendarSlot.findMany.mockResolvedValueOnce([]);
      prisma.branchSettings.findUnique.mockResolvedValueOnce(null);
      prisma.bookingRequest.findMany.mockResolvedValueOnce([]);
      prisma.work.findMany.mockResolvedValueOnce([]);

      // 2026-06-01 — понеділок
      const slots = await service.getAvailability(orgId, branchId, '2026-06-01');
      expect(slots.length).toBeGreaterThan(0);
      // Перший слот має бути 09:00 Kyiv (= 06:00Z літо)
      expect(slots[0]!.startAt).toBe('2026-06-01T06:00:00.000Z');
    });
  });

  describe('confirm', () => {
    it('Bug #249 pattern: updateMany з { id, orgId, deletedAt: null }, не голий update', async () => {
      prisma.bookingRequest.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.bookingRequest.findFirstOrThrow.mockResolvedValueOnce({
        id: bookingId,
        status: 'CONFIRMED',
        clientName: 'Тест',
        clientPhone: '+380501234567',
        requestedDate: new Date(),
        branchId,
        notes: null,
        createdAt: new Date(),
      });

      const result = await service.confirm(orgId, bookingId);

      expect(prisma.bookingRequest.updateMany).toHaveBeenCalledTimes(1);
      const args = prisma.bookingRequest.updateMany.mock.calls[0][0];
      expect(args.where.id).toBe(bookingId);
      expect(args.where.orgId).toBe(orgId);
      expect(args.where.deletedAt).toBe(null);
      expect(args.data.status).toBe('CONFIRMED');

      // Defense-in-depth: НЕ використовувати голий update without orgId.
      expect(prisma.bookingRequest.update).not.toHaveBeenCalled();

      expect(result.status).toBe('CONFIRMED');
    });

    it('cross-tenant booking → NotFoundException (count === 0)', async () => {
      prisma.bookingRequest.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.confirm(orgId, bookingId)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.bookingRequest.findFirstOrThrow).not.toHaveBeenCalled();
    });

    // CAL-H3/H4 (conservative slice): коли передано slotId — він валідується проти org
    // ДО підтвердження. Без slotId — стара поведінка (жодного запиту calendarSlot).
    it('CAL-H3/H4: slotId відсутній → calendarSlot НЕ запитується (стара поведінка)', async () => {
      prisma.calendarSlot = { findFirst: vi.fn() };
      prisma.bookingRequest.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.bookingRequest.findFirstOrThrow.mockResolvedValueOnce({
        id: bookingId,
        status: 'CONFIRMED',
        clientName: 'Тест',
        clientPhone: '+380501234567',
        requestedDate: new Date(),
        branchId,
        notes: null,
        createdAt: new Date(),
      });

      await service.confirm(orgId, bookingId);
      expect(prisma.calendarSlot.findFirst).not.toHaveBeenCalled();
    });

    it('CAL-H3/H4: slotId з чужої org / неіснуючий → NotFoundException; booking НЕ підтверджується', async () => {
      const slotId = '44444444-4444-4444-8444-444444444444';
      prisma.calendarSlot = { findFirst: vi.fn().mockResolvedValueOnce(null) };
      prisma.bookingRequest.updateMany = vi.fn();

      await expect(service.confirm(orgId, bookingId, slotId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // Валідація слота передує updateMany — заявка не підтверджується.
      expect(prisma.bookingRequest.updateMany).not.toHaveBeenCalled();
      expect(prisma.calendarSlot.findFirst).toHaveBeenCalledWith({
        where: { id: slotId, orgId, deletedAt: null },
        select: { id: true },
      });
    });

    it('CAL-H3/H4: валідний slotId у org → підтвердження проходить', async () => {
      const slotId = '55555555-5555-4555-8555-555555555555';
      prisma.calendarSlot = { findFirst: vi.fn().mockResolvedValueOnce({ id: slotId }) };
      prisma.bookingRequest.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.bookingRequest.findFirstOrThrow.mockResolvedValueOnce({
        id: bookingId,
        status: 'CONFIRMED',
        clientName: 'Тест',
        clientPhone: '+380501234567',
        requestedDate: new Date(),
        branchId,
        notes: null,
        createdAt: new Date(),
      });

      const result = await service.confirm(orgId, bookingId, slotId);
      expect(result.status).toBe('CONFIRMED');
      expect(prisma.bookingRequest.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancel', () => {
    it('soft-delete + status=CANCELLED у одному updateMany', async () => {
      prisma.bookingRequest.updateMany.mockResolvedValueOnce({ count: 1 });

      await service.cancel(orgId, bookingId);

      const args = prisma.bookingRequest.updateMany.mock.calls[0][0];
      expect(args.where.id).toBe(bookingId);
      expect(args.where.orgId).toBe(orgId);
      expect(args.where.deletedAt).toBe(null);
      expect(args.data.status).toBe('CANCELLED');
      expect(args.data.deletedAt).toBeInstanceOf(Date);
    });

    it('повторний cancel (вже soft-deleted) → NotFoundException', async () => {
      prisma.bookingRequest.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.cancel(orgId, bookingId)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
