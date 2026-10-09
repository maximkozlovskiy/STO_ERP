/**
 * Reports — HTTP-контракт дат періоду.
 *
 * Обов'язкові межі (`from` / `to`) у виручці, нарядах, рентабельності, завантаженості й ПДВ:
 * відсутня, порожня, неіснуюча чи повторена дата — 400 ще в контролері, сервіс не викликається
 * (раніше `GET /reports/revenue` без `from` доходив до сервісу з `undefined` і падав на
 * `Invalid Date`). У звіті по складу дати необов'язкові: без них — 200, зі сміттям — 400.
 *
 * Mutation-verify: прибрати `assertRequiredCalendarDateQuery(from, to)` з маршруту → його кейси
 * 400 падають (приходить 200); замінити на `assertCalendarDateQuery` → падають «без from» і
 * «порожній»; прибрати `assertCalendarDateQuery` зі stock → падає кейс `abc`.
 */
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const serviceMock = {
  revenue: vi.fn(),
  workOrders: vi.fn(),
  stock: vi.fn(),
  profitability: vi.fn(),
  settlements: vi.fn(),
  load: vi.fn(),
  vatReport: vi.fn(),
};

const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: 'emp-1', orgId: 'org-1', role: 'OWNER' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

/** Маршрут з обов'язковим періодом → метод сервісу, який він викликає. */
const REQUIRED_ROUTES = [
  ['revenue', 'revenue'],
  ['work-orders', 'workOrders'],
  ['profitability', 'profitability'],
  ['load', 'load'],
  ['vat', 'vatReport'],
] as const;

const BAD_PERIODS = [
  ['без from', 'to=2026-10-09'],
  ['без to', 'from=2026-10-01'],
  ['без обох дат', ''],
  ['порожній from', 'from=&to=2026-10-09'],
  ['порожній to', 'from=2026-10-01&to='],
  ['неіснуюча дата 2026-02-31', 'from=2026-02-31&to=2026-10-09'],
  ['неіснуюча дата в to', 'from=2026-02-01&to=2026-02-31'],
  ['рік 0000', 'from=0000-01-01&to=2026-10-09'],
  ['дата з часом', 'from=2026-10-01T00:00:00.000Z&to=2026-10-09'],
  ['повторений from', 'from=2026-10-01&from=2026-10-02&to=2026-10-09'],
  ['повторений to', 'from=2026-10-01&to=2026-10-08&to=2026-10-09'],
] as const;

describe('Reports — HTTP-контракт дат періоду', () => {
  let app: INestApplication;

  const get = (url: string) => (app as NestFastifyApplication).inject({ method: 'GET', url });

  const expectNoServiceCall = () => {
    for (const fn of Object.values(serviceMock)) expect(fn).not.toHaveBeenCalled();
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [{ provide: ReportsService, useValue: serviceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    for (const fn of Object.values(serviceMock)) {
      fn.mockReset();
      fn.mockResolvedValue({});
    }
  });

  describe.each(REQUIRED_ROUTES)('GET /reports/%s — період обовʼязковий', (path, method) => {
    it.each(BAD_PERIODS)('%s → 400, сервіс не викликається', async (_name, query) => {
      const res = await get(`/reports/${path}?${query}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/Невірна дата у відборі/);
      expectNoServiceCall();
    });

    it('коректний період → 200, сервіс отримує обидві дати як є', async () => {
      const res = await get(`/reports/${path}?from=2026-10-01&to=2026-10-09`);
      expect(res.statusCode).toBe(200);
      expect(serviceMock[method]).toHaveBeenCalledTimes(1);
      expect(serviceMock[method].mock.calls[0].slice(0, 3)).toEqual([
        'org-1',
        '2026-10-01',
        '2026-10-09',
      ]);
    });

    it('один день (from = to) і 29 лютого високосного року → 200', async () => {
      expect((await get(`/reports/${path}?from=2026-10-09&to=2026-10-09`)).statusCode).toBe(200);
      expect((await get(`/reports/${path}?from=2024-02-29&to=2024-02-29`)).statusCode).toBe(200);
    });
  });

  describe('GET /reports/stock — дати необовʼязкові', () => {
    it('без дат → 200, сервіс отримує undefined-и', async () => {
      const res = await get('/reports/stock');
      expect(res.statusCode).toBe(200);
      expect(serviceMock.stock).toHaveBeenCalledWith('org-1', undefined, undefined, undefined);
    });

    it('порожні дати → 200 («межі немає», не помилка)', async () => {
      const res = await get('/reports/stock?from=&to=');
      expect(res.statusCode).toBe(200);
      expect(serviceMock.stock).toHaveBeenCalledTimes(1);
    });

    it('коректні дати → 200 і доходять до сервісу', async () => {
      const res = await get('/reports/stock?from=2026-10-01&to=2026-10-09');
      expect(res.statusCode).toBe(200);
      expect(serviceMock.stock).toHaveBeenCalledWith(
        'org-1',
        undefined,
        '2026-10-01',
        '2026-10-09',
      );
    });

    it.each([
      'from=abc',
      'to=abc',
      'from=2026-02-31',
      'to=2026-10-09T10:00:00Z',
      'from=2026-10-01&from=2026-10-02',
    ])('%s → 400, сервіс не викликається', async query => {
      const res = await get(`/reports/stock?${query}`);
      expect(res.statusCode).toBe(400);
      expectNoServiceCall();
    });
  });

  it('GET /reports/settlements дат не має — працює без них', async () => {
    const res = await get('/reports/settlements');
    expect(res.statusCode).toBe(200);
    expect(serviceMock.settlements).toHaveBeenCalledTimes(1);
  });
});
