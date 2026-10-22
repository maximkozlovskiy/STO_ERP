import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { WarrantiesController } from './warranties.controller';
import { WarrantiesService } from './warranties.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';

/**
 * HTTP-контракт `GET /warranties` (BR-WAR-001, BR-WAR-002): розбір і перевірка параметрів —
 * тією самою `ValidationPipe`, що в main.ts; ролі — справжнім `RolesGuard` (підмінено лише
 * JWT, який кладе користувача з потрібною роллю); маршрут не перекриває `expiring`.
 */

const serviceMock = {
  findAll: vi.fn(),
  findExpiring: vi.fn(),
  findByCounterparty: vi.fn(),
  findByWorkOrder: vi.fn(),
  create: vi.fn(),
  claim: vi.fn(),
};

let role = 'ADMIN';
const jwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    ctx.switchToHttp().getRequest().user = { sub: 'emp-1', id: 'emp-1', orgId: 'org-1', role };
    return true;
  }),
};

const EMPTY = { items: [], total: 0, page: 1, limit: 20 };

describe('Warranties — HTTP контракт списку', () => {
  let app: NestFastifyApplication;
  const get = (url: string) => app.inject({ method: 'GET', url });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WarrantiesController],
      providers: [{ provide: WarrantiesService, useValue: serviceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(jwtGuard)
      .compile();
    const nest: INestApplication = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    nest.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await nest.init();
    app = nest as NestFastifyApplication;
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    role = 'ADMIN';
    serviceMock.findAll.mockReset().mockResolvedValue(EMPTY);
    serviceMock.findExpiring.mockReset().mockResolvedValue({ items: [], total: 0 });
  });

  // guards: BR-WAR-001
  it('200 { items, total, page, limit }; організація — з токена, page/limit — числа', async () => {
    const res = await get('/warranties?page=2&limit=50');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(EMPTY);
    expect(serviceMock.findAll).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ page: 2, limit: 50 }),
    );
  });

  // guards: BR-WAR-001
  it.each([
    ['limit понад 200', '/warranties?limit=201'],
    ['sortBy поза whitelist', '/warranties?sortBy=description'],
    ['sortDir не asc/desc', '/warranties?sortDir=up'],
    ['q довший за 100', `/warranties?q=${'а'.repeat(101)}`],
    ['id не UUID', '/warranties?id=abc'],
  ])('%s → 400, сервіс не викликано', async (_why, url) => {
    const res = await get(encodeURI(url));

    expect(res.statusCode).toBe(400);
    expect(serviceMock.findAll).not.toHaveBeenCalled();
  });

  // guards: BR-WAR-002
  it.each([
    ['через кому', '/warranties?state=ACTIVE,EXPIRING', ['ACTIVE', 'EXPIRING']],
    ['повторений параметр', '/warranties?state=EXPIRED&state=CLAIMED', ['EXPIRED', 'CLAIMED']],
    ['з пробілами й порожнім', '/warranties?state=ACTIVE,%20CLAIMED,', ['ACTIVE', 'CLAIMED']],
  ])('?state= %s → масив станів у сервіс', async (_how, url, expected) => {
    const res = await get(url);

    expect(res.statusCode).toBe(200);
    expect(serviceMock.findAll.mock.calls[0][1].state).toEqual(expected);
  });

  // guards: BR-WAR-002
  it('невідоме значення стану → 400, сервіс не викликано', async () => {
    const res = await get('/warranties?state=ACTIVE,VALID');

    expect(res.statusCode).toBe(400);
    expect(serviceMock.findAll).not.toHaveBeenCalled();
  });

  // guards: BR-WAR-001
  it.each(['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT'])('роль %s бачить список', async r => {
    role = r;
    expect((await get('/warranties')).statusCode).toBe(200);
  });

  // guards: BR-WAR-001
  it.each(['MECHANIC', 'STOREKEEPER'])('роль %s → 403', async r => {
    role = r;
    expect((await get('/warranties')).statusCode).toBe(403);
    expect(serviceMock.findAll).not.toHaveBeenCalled();
  });

  it('`GET /warranties/expiring` лишився своїм маршрутом (не перекритий списком)', async () => {
    const res = await get('/warranties/expiring?days=30');

    expect(res.statusCode).toBe(200);
    expect(serviceMock.findExpiring).toHaveBeenCalledWith('org-1', 30);
    expect(serviceMock.findAll).not.toHaveBeenCalled();
  });
});
