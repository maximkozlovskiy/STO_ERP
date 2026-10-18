import type { INestApplication } from '@nestjs/common';
import { ValidationPipe, NotFoundException, BadRequestException } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { WorkOrdersService } from '../work-orders/work-orders.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const serviceMock = {
  findSlots: vi.fn(),
  checkConflicts: vi.fn(),
};
// BR-WO-024/026: зміну й видалення запису проводить наряд.
const woServiceMock = {
  // BR-WO-028 (Bug #905): створення запису йде через наряд — запис для наряду стає записом наряду.
  createCalendarSlot: vi.fn(),
  updateCalendarSlot: vi.fn(),
  removeCalendarSlot: vi.fn(),
};

let jwtAllow = true;
let jwtRole = 'ADMIN';
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    // sub/id parity: @CurrentUser() reads request.user; jwt.strategy returns { id, orgId, role }.
    req.user = { id: 'emp-1', sub: 'emp-1', orgId: 'org-1', role: jwtRole };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

// v4-layout UUIDs (13-й hex = '4', 17-й ∈ 8-b) — @IsUUID() (version 'all') приймає.
const SLOT_ID = '11111111-1111-4111-8111-111111111111';
const LIFT_ID = '22222222-2222-4222-8222-222222222222';
const WO_ID = '33333333-3333-4333-8333-333333333333';

describe('Calendar — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CalendarController],
      providers: [
        { provide: CalendarService, useValue: serviceMock },
        { provide: WorkOrdersService, useValue: woServiceMock },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Mirror production pipe (main.ts) so @IsUUID/@IsISO8601 → 400.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jwtAllow = true;
    jwtRole = 'ADMIN';
    vi.clearAllMocks();
  });

  describe('GET /calendar/slots', () => {
    it('повертає 200 + масив слотів, прокидає date + user.role у сервіс', async () => {
      serviceMock.findSlots.mockResolvedValueOnce([]);
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/calendar/slots?date=2026-05-22',
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
      // Security (11c8ded7): role прокидається 3-м аргументом для PII-strip MECHANIC.
      expect(serviceMock.findSlots).toHaveBeenCalledWith(
        'org-1',
        '2026-05-22',
        'ADMIN',
        undefined,
        undefined,
      );
    });

    it('прокидає branchId/employeeId-фільтри + role у сервіс', async () => {
      serviceMock.findSlots.mockResolvedValueOnce([]);
      await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/calendar/slots?date=2026-05-22&branchId=${LIFT_ID}&employeeId=${WO_ID}`,
      });
      expect(serviceMock.findSlots).toHaveBeenCalledWith(
        'org-1',
        '2026-05-22',
        'ADMIN',
        LIFT_ID,
        WO_ID,
      );
    });

    // Security regression (11c8ded7): MECHANIC role → service отримує 'MECHANIC',
    // щоб піти narrow-SELECT-гілкою без counterparty/vehicle PII.
    it('прокидає role="MECHANIC" коли юзер — механік (PII-strip path)', async () => {
      jwtRole = 'MECHANIC';
      serviceMock.findSlots.mockResolvedValueOnce([]);
      await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/calendar/slots?date=2026-05-22',
      });
      expect(serviceMock.findSlots).toHaveBeenCalledWith(
        'org-1',
        '2026-05-22',
        'MECHANIC',
        undefined,
        undefined,
      );
    });

    // guards: BR-CAL-011
    it("віддає employeeName запису як є: ім'я механіка або null", async () => {
      serviceMock.findSlots.mockResolvedValueOnce([
        {
          id: SLOT_ID,
          startAt: 'a',
          endAt: 'b',
          status: 'BOOKED',
          type: 'WORK',
          employeeName: 'Коваль Петро',
        },
        { id: WO_ID, startAt: 'a', endAt: 'b', status: 'BOOKED', type: 'WORK', employeeName: null },
      ]);
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/calendar/slots?date=2026-05-22',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().map((s: { employeeName: unknown }) => s.employeeName)).toEqual([
        'Коваль Петро',
        null,
      ]);
    });

    it('повертає 400 коли branchId не UUID (ParseUUIDPipe optional)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/calendar/slots?date=2026-05-22&branchId=not-a-uuid',
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.findSlots).not.toHaveBeenCalled();
    });

    it('повертає 403 коли guard не пропустив', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/calendar/slots?date=2026-05-22',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /calendar/slots — валідація', () => {
    it('повертає 400 коли startAt/endAt відсутні', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/calendar/slots',
        payload: { notes: 'без часу' },
      });
      expect(res.statusCode).toBe(400);
      expect(woServiceMock.createCalendarSlot).not.toHaveBeenCalled();
    });

    it('повертає 400 коли startAt не ISO-8601', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/calendar/slots',
        payload: { startAt: '2026/05/22 10:00', endAt: '2026-05-22T11:00:00.000Z' },
      });
      expect(res.statusCode).toBe(400);
      expect(woServiceMock.createCalendarSlot).not.toHaveBeenCalled();
    });

    it('повертає 400 коли liftId не UUID', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/calendar/slots',
        payload: {
          liftId: 'not-a-uuid',
          startAt: '2026-05-22T10:00:00.000Z',
          endAt: '2026-05-22T11:00:00.000Z',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(woServiceMock.createCalendarSlot).not.toHaveBeenCalled();
    });

    it('повертає 400 коли endAt <= startAt (бізнес-правило сервісу)', async () => {
      woServiceMock.createCalendarSlot.mockRejectedValueOnce(
        new BadRequestException('Час завершення має бути після початку'),
      );
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/calendar/slots',
        payload: { startAt: '2026-05-22T11:00:00.000Z', endAt: '2026-05-22T10:00:00.000Z' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 201 + DTO при валідному payload', async () => {
      woServiceMock.createCalendarSlot.mockResolvedValueOnce({
        id: SLOT_ID,
        liftId: LIFT_ID,
        employeeId: null,
        workOrderId: null,
        startAt: new Date('2026-05-22T10:00:00.000Z'),
        endAt: new Date('2026-05-22T11:00:00.000Z'),
        notes: null,
        status: 'BOOKED',
        type: 'WORK',
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/calendar/slots',
        payload: {
          liftId: LIFT_ID,
          startAt: '2026-05-22T10:00:00.000Z',
          endAt: '2026-05-22T11:00:00.000Z',
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: SLOT_ID, liftId: LIFT_ID });
      expect(woServiceMock.createCalendarSlot).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ liftId: LIFT_ID }),
        'emp-1',
      );
    });

    // BR-CAL-004: значення AVAILABLE ніхто не створює, але DTO його формально приймає —
    // якщо enum у DTO звузять, правило в дос'є треба переписати разом із ним.
    // guards: BR-CAL-004
    it.each(['AVAILABLE', 'BOOKED', 'BLOCKED'])(
      'приймає status=%s і передає його в сервіс як є (201)',
      async status => {
        woServiceMock.createCalendarSlot.mockResolvedValueOnce({ slots: [] });
        const res = await (app as NestFastifyApplication).inject({
          method: 'POST',
          url: '/calendar/slots',
          payload: {
            liftId: LIFT_ID,
            status,
            startAt: '2026-05-22T10:00:00.000Z',
            endAt: '2026-05-22T11:00:00.000Z',
          },
        });
        expect(res.statusCode).toBe(201);
        expect(woServiceMock.createCalendarSlot).toHaveBeenCalledWith(
          'org-1',
          expect.objectContaining({ status }),
          'emp-1',
        );
      },
    );

    // Bug #244 regression-guard: @Transform(emptyToUndefined) у CreateCalendarSlotDto
    // має зробити '' → undefined для liftId/employeeId/workOrderId/counterpartyId.
    // Без цього sprint c551dd5 буде регресувати у 400 без видимих тестових провалів.
    it('повертає 201 коли liftId="" і employeeId="" (порожні рядки → undefined)', async () => {
      woServiceMock.createCalendarSlot.mockResolvedValueOnce({
        id: SLOT_ID,
        liftId: null,
        employeeId: null,
        workOrderId: null,
        startAt: new Date('2026-05-22T10:00:00.000Z'),
        endAt: new Date('2026-05-22T11:00:00.000Z'),
        notes: null,
        status: 'BOOKED',
        type: 'WORK',
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/calendar/slots',
        payload: {
          liftId: '',
          employeeId: '',
          workOrderId: '',
          counterpartyId: '',
          startAt: '2026-05-22T10:00:00.000Z',
          endAt: '2026-05-22T11:00:00.000Z',
        },
      });
      expect(res.statusCode).toBe(201);
      const dtoArg = woServiceMock.createCalendarSlot.mock.calls[0]![1] as Record<string, unknown>;
      expect(dtoArg.liftId).toBeUndefined();
      expect(dtoArg.employeeId).toBeUndefined();
      expect(dtoArg.workOrderId).toBeUndefined();
      expect(dtoArg.counterpartyId).toBeUndefined();
    });
  });

  describe('PATCH /calendar/slots/:id', () => {
    it('повертає 400 коли :id не UUID (ParseUUIDPipe)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: '/calendar/slots/not-a-uuid',
        payload: { notes: 'x' },
      });
      expect(res.statusCode).toBe(400);
      expect(woServiceMock.updateCalendarSlot).not.toHaveBeenCalled();
    });

    it('повертає 404 коли слот належить іншому orgId (сервіс кидає NotFound)', async () => {
      woServiceMock.updateCalendarSlot.mockRejectedValueOnce(
        new NotFoundException('Слот не знайдено'),
      );
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/calendar/slots/${SLOT_ID}`,
        payload: { startAt: '2026-05-22T10:00:00.000Z', endAt: '2026-05-22T11:00:00.000Z' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('повертає 200 + оновлений слот при валідному PATCH', async () => {
      woServiceMock.updateCalendarSlot.mockResolvedValueOnce({
        id: SLOT_ID,
        liftId: LIFT_ID,
        employeeId: null,
        workOrderId: null,
        startAt: new Date('2026-05-22T09:00:00.000Z'),
        endAt: new Date('2026-05-22T10:30:00.000Z'),
        notes: null,
        status: 'BOOKED',
        type: 'WORK',
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/calendar/slots/${SLOT_ID}`,
        payload: { startAt: '2026-05-22T09:00:00.000Z', endAt: '2026-05-22T10:30:00.000Z' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: SLOT_ID });
      // guards: BR-WO-024 — зміна запису йде через наряд, з користувачем для журналу наряду.
      expect(woServiceMock.updateCalendarSlot).toHaveBeenCalledWith(
        'org-1',
        SLOT_ID,
        expect.objectContaining({ startAt: '2026-05-22T09:00:00.000Z' }),
        'emp-1',
      );
    });

    // guards: BR-CAL-012
    it('employeeId: null («— без механіка —» у формі) проходить валідацію і доходить до сервісу', async () => {
      woServiceMock.updateCalendarSlot.mockResolvedValueOnce({
        id: SLOT_ID,
        liftId: LIFT_ID,
        employeeId: null,
        startAt: '2026-05-22T09:00:00.000Z',
        endAt: '2026-05-22T10:00:00.000Z',
        status: 'BOOKED',
        type: 'WORK',
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/calendar/slots/${SLOT_ID}`,
        payload: { liftId: LIFT_ID, employeeId: null },
      });
      expect(res.statusCode).toBe(200);
      const dto = woServiceMock.updateCalendarSlot.mock.calls[0][2];
      expect(dto).toHaveProperty('employeeId', null);
      expect(dto.liftId).toBe(LIFT_ID);
    });

    // Bug #901: стерта у формі примітка приходить `null` — валідація пропускає, сервіс стирає.
    it('notes: null (примітку стерто у формі) проходить валідацію і доходить до сервісу', async () => {
      woServiceMock.updateCalendarSlot.mockResolvedValueOnce({
        id: SLOT_ID,
        liftId: LIFT_ID,
        notes: null,
        startAt: '2026-05-22T09:00:00.000Z',
        endAt: '2026-05-22T10:00:00.000Z',
        status: 'BOOKED',
        type: 'WORK',
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/calendar/slots/${SLOT_ID}`,
        payload: { liftId: LIFT_ID, notes: null },
      });
      expect(res.statusCode).toBe(200);
      expect(woServiceMock.updateCalendarSlot.mock.calls[0][2]).toHaveProperty('notes', null);
    });
  });

  describe('DELETE /calendar/slots/:id', () => {
    // guards: BR-WO-026 — видалення йде через наряд, з користувачем для журналу змін наряду.
    it('повертає 204 при успіху (soft delete)', async () => {
      woServiceMock.removeCalendarSlot.mockResolvedValueOnce(undefined);
      const res = await (app as NestFastifyApplication).inject({
        method: 'DELETE',
        url: `/calendar/slots/${SLOT_ID}`,
      });
      expect(res.statusCode).toBe(204);
      expect(woServiceMock.removeCalendarSlot).toHaveBeenCalledWith('org-1', SLOT_ID, 'emp-1');
    });

    it('повертає 404 коли слот не знайдено', async () => {
      woServiceMock.removeCalendarSlot.mockRejectedValueOnce(
        new NotFoundException('Слот не знайдено'),
      );
      const res = await (app as NestFastifyApplication).inject({
        method: 'DELETE',
        url: `/calendar/slots/${SLOT_ID}`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /calendar/slots/check-conflicts', () => {
    const EMPTY_RESULT = {
      liftConflict: false,
      employeeConflict: false,
      anyConflict: false,
      conflictSlots: [],
    };

    it('повертає 200 + порожній результат коли немає liftId+employeeId (read-only, short-circuit)', async () => {
      serviceMock.checkConflicts.mockResolvedValueOnce(EMPTY_RESULT);
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/calendar/slots/check-conflicts',
        payload: {
          startAt: '2026-05-22T10:00:00.000Z',
          endAt: '2026-05-22T11:00:00.000Z',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ anyConflict: false });
    });

    it('прокидає excludeWorkOrderId у сервіс (Bug #397: edit own WO has no false positives)', async () => {
      serviceMock.checkConflicts.mockResolvedValueOnce(EMPTY_RESULT);
      await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/calendar/slots/check-conflicts',
        payload: {
          liftId: LIFT_ID,
          startAt: '2026-05-22T10:00:00.000Z',
          endAt: '2026-05-22T11:00:00.000Z',
          excludeWorkOrderId: WO_ID,
        },
      });
      expect(serviceMock.checkConflicts).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ excludeWorkOrderId: WO_ID, liftId: LIFT_ID }),
      );
    });

    it('повертає 400 коли excludeWorkOrderId не UUID', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/calendar/slots/check-conflicts',
        payload: {
          liftId: LIFT_ID,
          startAt: '2026-05-22T10:00:00.000Z',
          endAt: '2026-05-22T11:00:00.000Z',
          excludeWorkOrderId: 'not-a-uuid',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.checkConflicts).not.toHaveBeenCalled();
    });

    it('emptyToUndefined: excludeWorkOrderId="" → проходить валідацію', async () => {
      serviceMock.checkConflicts.mockResolvedValueOnce(EMPTY_RESULT);
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/calendar/slots/check-conflicts',
        payload: {
          liftId: LIFT_ID,
          startAt: '2026-05-22T10:00:00.000Z',
          endAt: '2026-05-22T11:00:00.000Z',
          excludeWorkOrderId: '',
        },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // guards: BR-WO-026 — застарілий ендпоінт видалено (клієнтів не було): шлях більше не веде в
  // наряд, а `PATCH /calendar/slots/:id` його не підхоплює (два сегменти).
  it('PATCH /calendar/slots/by-work-order/:workOrderId — 404, наряд не чіпається', async () => {
    const res = await (app as NestFastifyApplication).inject({
      method: 'PATCH',
      url: `/calendar/slots/by-work-order/${WO_ID}`,
      payload: {
        startAt: '2026-05-22T10:00:00.000Z',
        endAt: '2026-05-22T11:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(woServiceMock.updateCalendarSlot).not.toHaveBeenCalled();
  });
});
