import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { CashRegistersController } from './cash-registers.controller';
import { CashRegistersService } from './cash-registers.service';
import { CashService } from '../cash/cash.service';
import { CashDeskService } from './cash-desk.service';
import { PrismaService } from '../../prisma/prisma.service';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const serviceMock = {
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
};
const cashMock = {
  getBalance: vi.fn().mockResolvedValue(0),
  listOperations: vi.fn().mockResolvedValue([]),
  // Понад контракт: після CashDeskService.create контролер перечитує рядок журналу для відповіді.
  getOperation: vi.fn().mockResolvedValue({ id: 'op-1' }),
};
// Ручна касова операція йде в CashDeskService (BR-CASH-016…021), а не в CashService.
const deskMock = {
  create: vi.fn().mockResolvedValue({ id: 'op-1' }),
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
const CURRENCY_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const REGISTER_ID = '33333333-3333-4333-8333-333333333333';
const COUNTERPARTY_ID = '55555555-5555-4555-8555-555555555555';
const EMPLOYEE_ID = '66666666-6666-4666-8666-666666666666';
const WORK_ORDER_ID = '77777777-7777-4777-8777-777777777777';

describe('CashRegisters — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CashRegistersController],
      providers: [
        { provide: CashRegistersService, useValue: serviceMock },
        { provide: CashService, useValue: cashMock },
        { provide: CashDeskService, useValue: deskMock },
        // POST :id/operations несе @UseInterceptors(IdempotencyInterceptor) — DI має резолвити.
        { provide: PrismaService, useValue: {} },
        IdempotencyInterceptor,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Mirror production pipe (main.ts) so @IsUUID/@IsNotEmpty → 400.
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

  describe('GET /cash-registers', () => {
    it('повертає 200 + { items, total } (не голий масив)', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/cash-registers',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ items: expect.any(Array), total: expect.any(Number) });
    });

    it('прокидає branchId-фільтр у сервіс', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0 });
      await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/cash-registers?branchId=${BRANCH_ID}`,
      });
      expect(serviceMock.findAll).toHaveBeenCalledWith('org-1', BRANCH_ID);
    });

    it('повертає 403 коли guard не пропустив', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/cash-registers',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /cash-registers — валідація обовʼязкових полів', () => {
    it('повертає 400 коли currencyId/branchId відсутні', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/cash-registers',
        payload: { name: 'Каса №1' },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.create).not.toHaveBeenCalled();
    });

    it('повертає 400 коли currencyId не UUID', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/cash-registers',
        payload: { name: 'Каса №1', currencyId: 'not-a-uuid', branchId: BRANCH_ID },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.create).not.toHaveBeenCalled();
    });

    it('повертає 201 + DTO shape при валідному payload', async () => {
      serviceMock.create.mockResolvedValueOnce({
        id: 'cr-1',
        orgId: 'org-1',
        name: 'Каса №1',
        currencyId: CURRENCY_ID,
        currencyCode: 'UAH',
        currencySymbol: '₴',
        branchId: BRANCH_ID,
        branchName: 'Головний офіс',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/cash-registers',
        payload: { name: 'Каса №1', currencyId: CURRENCY_ID, branchId: BRANCH_ID },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        id: expect.any(String),
        name: 'Каса №1',
        currencyCode: 'UAH',
        branchName: 'Головний офіс',
      });
      expect(serviceMock.create).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ currencyId: CURRENCY_ID, branchId: BRANCH_ID }),
      );
    });
  });

  describe('GET /cash-registers/:id/operations', () => {
    it('порожні dateFrom/dateTo → 200 (не 400); сервіс отримує їх як є, типовий limit лишає за собою', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/cash-registers/${BRANCH_ID}/operations?dateFrom=&dateTo=`,
      });
      expect(res.statusCode).toBe(200);
      expect(cashMock.listOperations).toHaveBeenCalledWith('org-1', BRANCH_ID, undefined, {
        q: undefined,
        dateFrom: '',
        dateTo: '',
      });
    });
  });

  describe('POST /cash-registers/:id/operations — ручна касова операція', () => {
    const post = (payload: Record<string, unknown>) =>
      (app as NestFastifyApplication).inject({
        method: 'POST',
        url: `/cash-registers/${REGISTER_ID}/operations`,
        payload,
      });

    // guards: BR-CASH-016
    it('валідне тіло → 201; операція йде в CashDeskService.create(orgId, id каси, тіло, користувач), а не в CashService', async () => {
      const res = await post({ direction: 'IN', reason: 'OWNER_IN', amount: 1250.75 });
      expect(res.statusCode).toBe(201);
      expect(deskMock.create).toHaveBeenCalledTimes(1);
      expect(deskMock.create).toHaveBeenCalledWith(
        'org-1',
        REGISTER_ID,
        expect.objectContaining({ direction: 'IN', reason: 'OWNER_IN', amount: 1250.75 }),
        expect.objectContaining({ role: 'ADMIN' }),
      );
    });

    // guards: BR-CASH-016
    it.each([
      ['SUPPLIER_REFUND_IN', 'IN', { counterpartyId: COUNTERPARTY_ID }],
      ['ADVANCE_RETURN', 'IN', { employeeId: EMPLOYEE_ID }],
      ['BANK_WITHDRAWAL', 'IN', {}],
      ['OWNER_IN', 'IN', {}],
      ['ADVANCE_ISSUE', 'OUT', { employeeId: EMPLOYEE_ID }],
      ['BANK_DEPOSIT', 'OUT', {}],
      ['OWNER_OUT', 'OUT', {}],
    ])('новий привід %s маршрут приймає (201)', async (reason, direction, extra) => {
      const res = await post({ direction, reason, amount: 100, ...extra });
      expect(res.statusCode).toBe(201);
      expect(deskMock.create.mock.calls[0][2]).toMatchObject({ reason, direction, ...extra });
    });

    // guards: BR-CASH-020
    it('контрагент і документ-підстава доходять до сервісу (поля не відсікає whitelist)', async () => {
      const res = await post({
        direction: 'IN',
        reason: 'SALE_PAYMENT',
        amount: 3400.5,
        counterpartyId: COUNTERPARTY_ID,
        baseDocumentType: 'WorkOrder',
        baseDocumentId: WORK_ORDER_ID,
        notes: 'за наряд',
      });
      expect(res.statusCode).toBe(201);
      expect(deskMock.create.mock.calls[0][2]).toMatchObject({
        counterpartyId: COUNTERPARTY_ID,
        baseDocumentType: 'WorkOrder',
        baseDocumentId: WORK_ORDER_ID,
        amount: 3400.5,
        notes: 'за наряд',
      });
    });

    // guards: BR-CASH-016, BR-CASH-020
    it.each([
      ['невідомий привід', { direction: 'IN', reason: 'BOGUS', amount: 100 }],
      ['привід не відповідає напряму', { direction: 'OUT', reason: 'OWNER_IN', amount: 100 }],
      ['PAYROLL вручну', { direction: 'OUT', reason: 'PAYROLL', amount: 100 }],
      ['оплата без контрагента', { direction: 'IN', reason: 'SALE_PAYMENT', amount: 100 }],
      ['під звіт без працівника', { direction: 'OUT', reason: 'ADVANCE_ISSUE', amount: 100 }],
      ['витрата без статті', { direction: 'OUT', reason: 'EXPENSE', amount: 100 }],
      ['нульова сума', { direction: 'IN', reason: 'MANUAL_IN', amount: 0 }],
      [
        'підстава не того типу',
        {
          direction: 'IN',
          reason: 'SALE_PAYMENT',
          amount: 100,
          counterpartyId: COUNTERPARTY_ID,
          baseDocumentType: 'PurchaseOrder',
          baseDocumentId: WORK_ORDER_ID,
        },
      ],
      [
        'підстава без id',
        {
          direction: 'IN',
          reason: 'SALE_PAYMENT',
          amount: 100,
          counterpartyId: COUNTERPARTY_ID,
          baseDocumentType: 'WorkOrder',
        },
      ],
      [
        'контрагент не UUID',
        { direction: 'IN', reason: 'SALE_PAYMENT', amount: 100, counterpartyId: 'abc' },
      ],
    ])('%s → 400, до сервісу не доходить', async (_n, payload) => {
      const res = await post(payload);
      expect(res.statusCode).toBe(400);
      expect(deskMock.create).not.toHaveBeenCalled();
    });

    // guards: BR-CASH-016
    it('id каси не UUID → 400, до сервісу не доходить', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/cash-registers/not-a-uuid/operations',
        payload: { direction: 'IN', reason: 'MANUAL_IN', amount: 100 },
      });
      expect(res.statusCode).toBe(400);
      expect(deskMock.create).not.toHaveBeenCalled();
    });
  });
});
