import { ConflictException, INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ExchangeRatesController } from './exchange-rates.controller';
import { ExchangeRatesService } from './exchange-rates.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const serviceMock = {
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
};

let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx) => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: 'emp-1', orgId: 'org-1', role: 'ACCOUNTANT' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

const CURRENCY_ID = '11111111-1111-4111-8111-111111111111';

describe('ExchangeRates — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ExchangeRatesController],
      providers: [{ provide: ExchangeRatesService, useValue: serviceMock }],
    })
      .overrideGuard(JwtAuthGuard).useValue(mockJwtGuard)
      .overrideGuard(RolesGuard).useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
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

  it('GET /exchange-rates → 200 + { items, total }', async () => {
    serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0 });
    const res = await (app as NestFastifyApplication).inject({ method: 'GET', url: '/exchange-rates' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: expect.any(Array), total: expect.any(Number) });
  });

  it('GET /exchange-rates passes from/to/currencyId filters to service', async () => {
    serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0 });
    await (app as NestFastifyApplication).inject({
      method: 'GET',
      url: `/exchange-rates?currencyId=${CURRENCY_ID}&from=2026-01-01&to=2026-12-31`,
    });
    expect(serviceMock.findAll).toHaveBeenCalledWith('org-1', {
      currencyId: CURRENCY_ID, from: '2026-01-01', to: '2026-12-31',
    });
  });

  it('POST /exchange-rates → 400 при невалідній даті', async () => {
    const res = await (app as NestFastifyApplication).inject({
      method: 'POST', url: '/exchange-rates',
      payload: { currencyId: CURRENCY_ID, date: 'not-a-date', rate: 41.5 },
    });
    expect(res.statusCode).toBe(400);
    expect(serviceMock.create).not.toHaveBeenCalled();
  });

  it('POST /exchange-rates → 400 при від\'ємному курсі', async () => {
    const res = await (app as NestFastifyApplication).inject({
      method: 'POST', url: '/exchange-rates',
      payload: { currencyId: CURRENCY_ID, date: '2026-05-28', rate: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /exchange-rates → 409 при дублі (orgId, currencyId, date) — ConflictException, не 500', async () => {
    serviceMock.create.mockRejectedValueOnce(new ConflictException('Курс на цю дату вже існує'));
    const res = await (app as NestFastifyApplication).inject({
      method: 'POST', url: '/exchange-rates',
      payload: { currencyId: CURRENCY_ID, date: '2026-05-28', rate: 41.5 },
    });
    expect(res.statusCode).toBe(409);
  });

  it('POST /exchange-rates → 201 + rate/coefficient як числа', async () => {
    serviceMock.create.mockResolvedValueOnce({
      id: 'er-1', orgId: 'org-1', currencyId: CURRENCY_ID, currencyCode: 'USD',
      currencyName: 'Долар', date: '2026-05-28', rate: 41.5, coefficient: 1,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await (app as NestFastifyApplication).inject({
      method: 'POST', url: '/exchange-rates',
      payload: { currencyId: CURRENCY_ID, date: '2026-05-28', rate: 41.5 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ rate: expect.any(Number), coefficient: expect.any(Number) });
  });
});
