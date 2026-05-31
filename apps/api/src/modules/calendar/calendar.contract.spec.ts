import {
  INestApplication,
  ValidationPipe,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const serviceMock = {
  findSlots: vi.fn(),
  createSlot: vi.fn(),
  updateSlot: vi.fn(),
  removeSlot: vi.fn(),
};

let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: 'emp-1', orgId: 'org-1', role: 'ADMIN' };
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
      providers: [{ provide: CalendarService, useValue: serviceMock }],
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
    vi.clearAllMocks();
  });

  describe('GET /calendar/slots', () => {
    it('повертає 200 + масив слотів, прокидає date у сервіс', async () => {
      serviceMock.findSlots.mockResolvedValueOnce([]);
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/calendar/slots?date=2026-05-22',
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
      expect(serviceMock.findSlots).toHaveBeenCalledWith(
        'org-1',
        '2026-05-22',
        undefined,
        undefined,
      );
    });

    it('прокидає branchId/employeeId-фільтри у сервіс', async () => {
      serviceMock.findSlots.mockResolvedValueOnce([]);
      await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/calendar/slots?date=2026-05-22&branchId=${LIFT_ID}&employeeId=${WO_ID}`,
      });
      expect(serviceMock.findSlots).toHaveBeenCalledWith('org-1', '2026-05-22', LIFT_ID, WO_ID);
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
      expect(serviceMock.createSlot).not.toHaveBeenCalled();
    });

    it('повертає 400 коли startAt не ISO-8601', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/calendar/slots',
        payload: { startAt: '2026/05/22 10:00', endAt: '2026-05-22T11:00:00.000Z' },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.createSlot).not.toHaveBeenCalled();
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
      expect(serviceMock.createSlot).not.toHaveBeenCalled();
    });

    it('повертає 400 коли endAt <= startAt (бізнес-правило сервісу)', async () => {
      serviceMock.createSlot.mockRejectedValueOnce(
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
      serviceMock.createSlot.mockResolvedValueOnce({
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
      expect(serviceMock.createSlot).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ liftId: LIFT_ID }),
      );
    });

    // Bug #244 regression-guard: @Transform(emptyToUndefined) у CreateCalendarSlotDto
    // має зробити '' → undefined для liftId/employeeId/workOrderId/counterpartyId.
    // Без цього sprint c551dd5 буде регресувати у 400 без видимих тестових провалів.
    it('повертає 201 коли liftId="" і employeeId="" (порожні рядки → undefined)', async () => {
      serviceMock.createSlot.mockResolvedValueOnce({
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
      const dtoArg = serviceMock.createSlot.mock.calls[0]![1] as Record<string, unknown>;
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
      expect(serviceMock.updateSlot).not.toHaveBeenCalled();
    });

    it('повертає 404 коли слот належить іншому orgId (сервіс кидає NotFound)', async () => {
      serviceMock.updateSlot.mockRejectedValueOnce(new NotFoundException('Слот не знайдено'));
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/calendar/slots/${SLOT_ID}`,
        payload: { startAt: '2026-05-22T10:00:00.000Z', endAt: '2026-05-22T11:00:00.000Z' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('повертає 200 + оновлений слот при валідному PATCH', async () => {
      serviceMock.updateSlot.mockResolvedValueOnce({
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
      expect(serviceMock.updateSlot).toHaveBeenCalledWith(
        'org-1',
        SLOT_ID,
        expect.objectContaining({ startAt: '2026-05-22T09:00:00.000Z' }),
      );
    });
  });

  describe('DELETE /calendar/slots/:id', () => {
    it('повертає 204 при успіху (soft delete)', async () => {
      serviceMock.removeSlot.mockResolvedValueOnce(undefined);
      const res = await (app as NestFastifyApplication).inject({
        method: 'DELETE',
        url: `/calendar/slots/${SLOT_ID}`,
      });
      expect(res.statusCode).toBe(204);
      expect(serviceMock.removeSlot).toHaveBeenCalledWith('org-1', SLOT_ID);
    });

    it('повертає 404 коли слот не знайдено', async () => {
      serviceMock.removeSlot.mockRejectedValueOnce(new NotFoundException('Слот не знайдено'));
      const res = await (app as NestFastifyApplication).inject({
        method: 'DELETE',
        url: `/calendar/slots/${SLOT_ID}`,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
