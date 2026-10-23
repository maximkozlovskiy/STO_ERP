/**
 * HTTP-контракт `GET /payments` — query через `PaymentsListQueryDto` і глобальні труби застосунку
 * (`globalPipes()`, ті самі, що в main.ts). До 2026-10-24 параметри йшли без DTO:
 * `?method=a&method=b` ставав масивом у `where.method` (500 від Prisma), а NUL у `q` — 500 від
 * Postgres (TECH-DEBT §8 «Списки документів», п. 3 і 4).
 */
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { globalPipes } from '../../common/pipes/global-pipes';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { RequiredIdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { PrismaService } from '../../prisma/prisma.service';

const ORG = 'org-1';
const CP = '22222222-2222-4222-8222-222222222222';

const serviceMock = {
  findAll: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
};

const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user?: unknown }>();
    req.user = { id: 'emp-1', orgId: ORG, role: 'ACCOUNTANT' };
    return true;
  }),
};

describe('GET /payments — query DTO і NUL (HTTP-контракт)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        { provide: PaymentsService, useValue: serviceMock },
        // RequiredIdempotencyInterceptor на POST-маршрутах контролера — GET його не чіпає.
        { provide: PrismaService, useValue: {} },
        RequiredIdempotencyInterceptor,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(...globalPipes());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    serviceMock.findAll.mockClear();
  });

  const get = (url: string) =>
    (app as NestFastifyApplication).inject({ method: 'GET', url: `/payments${url}` });

  // guards: BR-PAY-025
  it('усі параметри рядками → 200; у сервіс ідуть ті самі значення, page/limit — числа', async () => {
    const res = await get(
      `?page=2&limit=50&counterpartyId=${CP}&dateFrom=2026-10-01&dateTo=2026-10-24&method=card&fiscalStatus=none&q=Петренко`,
    );
    expect(res.statusCode).toBe(200);
    expect(serviceMock.findAll).toHaveBeenCalledWith(ORG, {
      page: 2,
      limit: 50,
      counterpartyId: CP,
      dateFrom: '2026-10-01',
      dateTo: '2026-10-24',
      method: 'card',
      fiscalStatus: 'none',
      q: 'Петренко',
    });
  });

  it('без параметрів → page 1, limit 20 (як раніше)', async () => {
    const res = await get('');
    expect(res.statusCode).toBe(200);
    expect(serviceMock.findAll).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ page: 1, limit: 20, method: undefined, q: undefined }),
    );
  });

  // guards: BR-PAY-025
  it.each([
    ['method масивом', '?method=card&method=cash'],
    ['method довший за 64 символи', `?method=${'m'.repeat(65)}`],
    ['q масивом', '?q=a&q=b'],
    ['counterpartyId не UUID', '?counterpartyId=abc'],
    ['невідомий параметр', '?sortBy=amount'],
  ])('%s → 400, сервіс не викликається', async (_label, url) => {
    const res = await get(url);
    expect(res.statusCode).toBe(400);
    expect(serviceMock.findAll).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-025
  it('NUL у q → 400 з текстом, а не 500 від Postgres', async () => {
    const res = await get('?q=a%00b');
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('Запит містить недопустимий символ (NUL)');
    expect(serviceMock.findAll).not.toHaveBeenCalled();
  });
});
