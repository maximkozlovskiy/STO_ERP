import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { GoodsController } from './goods.controller';
import { GoodsService } from './goods.service';
import { BatchService } from '../inventory/batch.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

/**
 * Bug #453: contract spec для GET /goods/stock-totals — фіча "К-ть на складі"
 * у CreateWorkOrderModal (commit 0618c621). c0879445 додав UUID validation і
 * `ids?: string` optional; без contract spec регресія цих guards пройде CI green.
 */

const serviceMock = {
  stockTotals: vi.fn(),
};
const batchServiceMock = {};
const prismaMock = {};

const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: 'emp-1', orgId: 'org-1', role: 'ADMIN' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

const VALID_UUID_1 = '11111111-1111-4111-8111-111111111111';
const VALID_UUID_2 = '22222222-2222-4222-8222-222222222222';
const VALID_UUID_3 = '33333333-3333-4333-8333-333333333333';

describe('GET /goods/stock-totals — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [GoodsController],
      providers: [
        { provide: GoodsService, useValue: serviceMock },
        { provide: BatchService, useValue: batchServiceMock },
        { provide: PrismaService, useValue: prismaMock },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
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
    vi.clearAllMocks();
    // Re-establish JWT mock impl after clearAllMocks wipes it
    mockJwtGuard.canActivate.mockImplementation(ctx => {
      const req = ctx.switchToHttp().getRequest();
      req.user = { sub: 'emp-1', orgId: 'org-1', role: 'ADMIN' };
      return true;
    });
    mockRolesGuard.canActivate.mockReturnValue(true);
  });

  it('Bug #453: відсутній ids → 200 + [], сервіс викликаний з порожнім масивом', async () => {
    serviceMock.stockTotals.mockResolvedValueOnce([]);
    const res = await (app as NestFastifyApplication).inject({
      method: 'GET',
      url: '/goods/stock-totals',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(serviceMock.stockTotals).toHaveBeenCalledWith('org-1', []);
  });

  it('Bug #453: порожній ids="" → 200 + [], сервіс отримує []', async () => {
    serviceMock.stockTotals.mockResolvedValueOnce([]);
    const res = await (app as NestFastifyApplication).inject({
      method: 'GET',
      url: '/goods/stock-totals?ids=',
    });
    expect(res.statusCode).toBe(200);
    expect(serviceMock.stockTotals).toHaveBeenCalledWith('org-1', []);
  });

  it('Bug #453: валідні UUIDs → 200, сервіс отримує parsed array', async () => {
    serviceMock.stockTotals.mockResolvedValueOnce([
      { goodId: VALID_UUID_1, totalQuantity: 15 },
      { goodId: VALID_UUID_2, totalQuantity: 3 },
    ]);
    const res = await (app as NestFastifyApplication).inject({
      method: 'GET',
      url: `/goods/stock-totals?ids=${VALID_UUID_1},${VALID_UUID_2}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { goodId: VALID_UUID_1, totalQuantity: 15 },
      { goodId: VALID_UUID_2, totalQuantity: 3 },
    ]);
    expect(serviceMock.stockTotals).toHaveBeenCalledWith('org-1', [VALID_UUID_1, VALID_UUID_2]);
  });

  it('Bug #453: trim whitespace навколо UUIDs, пропускає порожні token-и', async () => {
    serviceMock.stockTotals.mockResolvedValueOnce([]);
    const res = await (app as NestFastifyApplication).inject({
      method: 'GET',
      url: `/goods/stock-totals?ids=${encodeURIComponent(` ${VALID_UUID_1} , , ${VALID_UUID_2} `)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(serviceMock.stockTotals).toHaveBeenCalledWith('org-1', [VALID_UUID_1, VALID_UUID_2]);
  });

  it('Bug #453: невалідний UUID → 400 BadRequestException + сервіс НЕ викликаний', async () => {
    const res = await (app as NestFastifyApplication).inject({
      method: 'GET',
      url: `/goods/stock-totals?ids=${VALID_UUID_1},not-a-uuid`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Некоректний goodId/);
    expect(serviceMock.stockTotals).not.toHaveBeenCalled();
  });

  it('Bug #453: SQL-injection attempt у ids → 400 (UUID regex захист)', async () => {
    const malicious = `${VALID_UUID_1},${encodeURIComponent("'; DROP TABLE stock_items;--")}`;
    const res = await (app as NestFastifyApplication).inject({
      method: 'GET',
      url: `/goods/stock-totals?ids=${malicious}`,
    });
    expect(res.statusCode).toBe(400);
    expect(serviceMock.stockTotals).not.toHaveBeenCalled();
  });

  it('Bug #453: >100 UUIDs → 400 з повідомленням про ліміт', async () => {
    // 101 валідні UUIDs
    const ids = Array.from(
      { length: 101 },
      (_, i) => `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
    );
    const res = await (app as NestFastifyApplication).inject({
      method: 'GET',
      url: `/goods/stock-totals?ids=${ids.join(',')}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Максимум 100 товарів/);
    expect(serviceMock.stockTotals).not.toHaveBeenCalled();
  });

  it('Bug #453: рівно 100 UUIDs → 200 (boundary, не off-by-one)', async () => {
    const ids = Array.from(
      { length: 100 },
      (_, i) => `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
    );
    serviceMock.stockTotals.mockResolvedValueOnce([]);
    const res = await (app as NestFastifyApplication).inject({
      method: 'GET',
      url: `/goods/stock-totals?ids=${ids.join(',')}`,
    });
    expect(res.statusCode).toBe(200);
    expect(serviceMock.stockTotals).toHaveBeenCalledTimes(1);
    expect((serviceMock.stockTotals.mock.calls[0][1] as string[]).length).toBe(100);
  });

  it('Bug #453: дублі UUID у ids (parts І newPart посилаються на той самий goodId) — сервіс отримує дублі', async () => {
    // Frontend dedupes через Set, але якщо запит прийде з дублями — backend не валиться.
    // Контракт: сервіс отримує те що клієнт надіслав, dedupe — обов'язок клієнта.
    serviceMock.stockTotals.mockResolvedValueOnce([{ goodId: VALID_UUID_1, totalQuantity: 10 }]);
    const res = await (app as NestFastifyApplication).inject({
      method: 'GET',
      url: `/goods/stock-totals?ids=${VALID_UUID_1},${VALID_UUID_1},${VALID_UUID_2}`,
    });
    expect(res.statusCode).toBe(200);
    expect(serviceMock.stockTotals).toHaveBeenCalledWith('org-1', [
      VALID_UUID_1,
      VALID_UUID_1,
      VALID_UUID_2,
    ]);
  });

  it('Bug #453: змішаний регістр у UUID (нижній/верхній) — UUID_RE case-insensitive → 200', async () => {
    const upperUuid = VALID_UUID_3.toUpperCase();
    serviceMock.stockTotals.mockResolvedValueOnce([]);
    const res = await (app as NestFastifyApplication).inject({
      method: 'GET',
      url: `/goods/stock-totals?ids=${upperUuid}`,
    });
    expect(res.statusCode).toBe(200);
    // Сервіс отримує саме upperUuid (без зміни кейсу)
    expect(serviceMock.stockTotals).toHaveBeenCalledWith('org-1', [upperUuid]);
  });

  it('Bug #453: token-и БЕЗ дефісів (типовий помилковий формат) → 400', async () => {
    const malformed = VALID_UUID_1.replace(/-/g, '');
    const res = await (app as NestFastifyApplication).inject({
      method: 'GET',
      url: `/goods/stock-totals?ids=${malformed}`,
    });
    expect(res.statusCode).toBe(400);
    expect(serviceMock.stockTotals).not.toHaveBeenCalled();
  });

  it('Bug #453: 403 коли JwtAuthGuard НЕ пропустив (RBAC integration sanity)', async () => {
    mockJwtGuard.canActivate.mockImplementationOnce(() => false);
    const res = await (app as NestFastifyApplication).inject({
      method: 'GET',
      url: `/goods/stock-totals?ids=${VALID_UUID_1}`,
    });
    expect(res.statusCode).toBe(403);
    expect(serviceMock.stockTotals).not.toHaveBeenCalled();
  });
});
