import { ConflictException, INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { CurrenciesController } from './currencies.controller';
import { CurrenciesService } from './currencies.service';
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
    req.user = { sub: 'emp-1', orgId: 'org-1', role: 'ADMIN' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

describe('Currencies — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CurrenciesController],
      providers: [{ provide: CurrenciesService, useValue: serviceMock }],
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

  it('GET /currencies → 200 + { items, total }', async () => {
    serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0 });
    const res = await (app as NestFastifyApplication).inject({ method: 'GET', url: '/currencies' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: expect.any(Array), total: expect.any(Number) });
  });

  it('GET /currencies → 403 без guard', async () => {
    jwtAllow = false;
    const res = await (app as NestFastifyApplication).inject({ method: 'GET', url: '/currencies' });
    expect(res.statusCode).toBe(403);
  });

  it('POST /currencies → 400 коли name/code відсутні', async () => {
    const res = await (app as NestFastifyApplication).inject({
      method: 'POST', url: '/currencies', payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(serviceMock.create).not.toHaveBeenCalled();
  });

  it('POST /currencies → 409 при дублі коду (ConflictException, не 500)', async () => {
    serviceMock.create.mockRejectedValueOnce(new ConflictException('Валюта з кодом "UAH" вже існує'));
    const res = await (app as NestFastifyApplication).inject({
      method: 'POST', url: '/currencies', payload: { name: 'Гривня', code: 'UAH' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('POST /currencies → 201 при валідних даних', async () => {
    serviceMock.create.mockResolvedValueOnce({
      id: 'c-1', orgId: 'org-1', name: 'Долар', fullName: null, internationalName: null,
      code: 'USD', symbol: '$', createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await (app as NestFastifyApplication).inject({
      method: 'POST', url: '/currencies', payload: { name: 'Долар', code: 'USD', symbol: '$' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: expect.any(String), code: 'USD' });
  });
});
