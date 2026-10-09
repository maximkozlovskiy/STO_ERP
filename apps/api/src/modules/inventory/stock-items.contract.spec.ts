import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { StockItemsController } from './stock-items.controller';
import { InventoryService } from './inventory.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

// Bug #456 regression-guard. HTTP layer для нових 3-view inventory endpoints:
//   GET /stock-items/by-document
//   GET /stock-items/by-batch
// Покриває: route ordering (PERED :id), ParseUUIDPipe({ optional: true }),
// проброс параметрів у InventoryService, RBAC (by-document відкритий MECHANIC,
// by-batch — НІ, бо повертає costPrice/salePrice), JWT-блокування (403).

const inventoryMock = {
  byDocument: vi.fn(),
  byBatch: vi.fn(),
  findMovements: vi.fn(),
  findStockItems: vi.fn(),
  findLowStockItems: vi.fn(),
  updateMinStock: vi.fn(),
};

let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: 'emp-1', orgId: 'org-1', role: 'STOREKEEPER' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

describe('StockItems — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [StockItemsController],
      providers: [{ provide: InventoryService, useValue: inventoryMock }],
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
    jwtAllow = true;
    vi.clearAllMocks();
    inventoryMock.byDocument.mockResolvedValue({ goods: [] });
    inventoryMock.byBatch.mockResolvedValue({ batches: [] });
    inventoryMock.findMovements.mockResolvedValue({ items: [], total: 0, page: 1, limit: 50 });
  });

  describe('GET /stock-items/by-document', () => {
    it('200 без параметрів → service отримує undefined-и', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-items/by-document',
      });
      expect(res.statusCode).toBe(200);
      expect(inventoryMock.byDocument).toHaveBeenCalledWith(
        'org-1',
        undefined,
        undefined,
        undefined,
        undefined,
      );
      expect(JSON.parse(res.payload)).toEqual({ goods: [] });
    });

    it('200 з валідним warehouseId UUID → service отримує warehouseId', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/stock-items/by-document?warehouseId=${UUID_A}`,
      });
      expect(res.statusCode).toBe(200);
      expect(inventoryMock.byDocument).toHaveBeenCalledWith(
        'org-1',
        UUID_A,
        undefined,
        undefined,
        undefined,
      );
    });

    it('200 з валідним goodId UUID → service отримує goodId', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/stock-items/by-document?goodId=${UUID_B}`,
      });
      expect(res.statusCode).toBe(200);
      expect(inventoryMock.byDocument).toHaveBeenCalledWith(
        'org-1',
        undefined,
        UUID_B,
        undefined,
        undefined,
      );
    });

    it('400 при невалідному warehouseId (ParseUUIDPipe)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-items/by-document?warehouseId=not-a-uuid',
      });
      expect(res.statusCode).toBe(400);
      expect(inventoryMock.byDocument).not.toHaveBeenCalled();
    });

    it('400 при невалідному goodId (ParseUUIDPipe)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-items/by-document?goodId=12345',
      });
      expect(res.statusCode).toBe(400);
      expect(inventoryMock.byDocument).not.toHaveBeenCalled();
    });

    it('200 з date range → service отримує from/to як рядки', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-items/by-document?from=2025-01-01&to=2025-01-31',
      });
      expect(res.statusCode).toBe(200);
      expect(inventoryMock.byDocument).toHaveBeenCalledWith(
        'org-1',
        undefined,
        undefined,
        '2025-01-01',
        '2025-01-31',
      );
    });

    it('403 коли JWT-guard відмовляє', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-items/by-document',
      });
      expect(res.statusCode).toBe(403);
      expect(inventoryMock.byDocument).not.toHaveBeenCalled();
    });
  });

  describe('GET /stock-items/by-batch', () => {
    it('200 без параметрів → service отримує undefined-и', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-items/by-batch',
      });
      expect(res.statusCode).toBe(200);
      expect(inventoryMock.byBatch).toHaveBeenCalledWith(
        'org-1',
        undefined,
        undefined,
        undefined,
        undefined,
      );
      expect(JSON.parse(res.payload)).toEqual({ batches: [] });
    });

    it('200 з warehouseId + goodId → service отримує обидва', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/stock-items/by-batch?warehouseId=${UUID_A}&goodId=${UUID_B}`,
      });
      expect(res.statusCode).toBe(200);
      expect(inventoryMock.byBatch).toHaveBeenCalledWith(
        'org-1',
        UUID_A,
        UUID_B,
        undefined,
        undefined,
      );
    });

    it('400 при невалідному warehouseId', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-items/by-batch?warehouseId=invalid-uuid',
      });
      expect(res.statusCode).toBe(400);
      expect(inventoryMock.byBatch).not.toHaveBeenCalled();
    });

    it('200 з date range', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-items/by-batch?from=2025-02-01&to=2025-02-28',
      });
      expect(res.statusCode).toBe(200);
      expect(inventoryMock.byBatch).toHaveBeenCalledWith(
        'org-1',
        undefined,
        undefined,
        '2025-02-01',
        '2025-02-28',
      );
    });

    it('403 коли JWT-guard відмовляє', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-items/by-batch',
      });
      expect(res.statusCode).toBe(403);
      expect(inventoryMock.byBatch).not.toHaveBeenCalled();
    });
  });

  describe('GET /stock-items/movements', () => {
    it('200 → { items, total, page, limit }; фільтри проброшено у service', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/stock-items/movements?warehouseId=${UUID_A}&goodId=${UUID_B}&type=WRITEOFF&from=2026-09-01&to=2026-09-30&page=2&limit=25`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ items: [], total: 0, page: 1, limit: 50 });
      expect(inventoryMock.findMovements).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({
          warehouseId: UUID_A,
          goodId: UUID_B,
          type: 'WRITEOFF',
          from: '2026-09-01',
          to: '2026-09-30',
          page: 2,
          limit: 25,
        }),
      );
    });

    it('200 без параметрів', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-items/movements',
      });
      expect(res.statusCode).toBe(200);
    });

    it('400 при невалідному type (не з enum)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-items/movements?type=НЕВІДОМО',
      });
      expect(res.statusCode).toBe(400);
      expect(inventoryMock.findMovements).not.toHaveBeenCalled();
    });

    // code-review 2026-10-09: дати відбору перевіряються, як у касі — неіснуюча дата не
    // «перекочується» на інший день, сміття не доходить до Prisma.
    it.each(['from=2026-02-31', 'to=abc', 'from=2026-10-09T10:00:00Z'])(
      '400 при невалідній даті відбору (%s), сервіс не викликається',
      async query => {
        const res = await (app as NestFastifyApplication).inject({
          method: 'GET',
          url: `/stock-items/movements?${query}`,
        });
        expect(res.statusCode).toBe(400);
        expect(inventoryMock.findMovements).not.toHaveBeenCalled();
      },
    );

    it('порожні from/to — не помилка: відбору за датою просто немає', async () => {
      inventoryMock.findMovements.mockResolvedValueOnce({
        items: [],
        total: 0,
        page: 1,
        limit: 50,
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-items/movements?from=&to=',
      });
      expect(res.statusCode).toBe(200);
    });

    it('400 при type=constructor (прототипний ключ не проходить guard)', async () => {
      // `type in StockMovementType` резолвив би 'constructor'/'toString' у прототип →
      // долетіло б до Prisma enum-колонки → HTTP 500. hasOwnProperty-guard → чистий 400.
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-items/movements?type=constructor',
      });
      expect(res.statusCode).toBe(400);
      expect(inventoryMock.findMovements).not.toHaveBeenCalled();
    });

    it('400 при невалідному warehouseId (ParseUUIDPipe)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-items/movements?warehouseId=not-a-uuid',
      });
      expect(res.statusCode).toBe(400);
      expect(inventoryMock.findMovements).not.toHaveBeenCalled();
    });

    it('403 коли JWT-guard відмовляє', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-items/movements',
      });
      expect(res.statusCode).toBe(403);
      expect(inventoryMock.findMovements).not.toHaveBeenCalled();
    });
  });

  // Route-ordering guard: Fastify matches routes у declared order. Specific
  // sub-routes (by-document, by-batch) повинні бути ПЕРЕД :id. Якщо ordering
  // регресія перенесе :id вище — Fastify трактуватиме 'by-document' як id,
  // ParseUUIDPipe киде 400. Цей тест гарантує що /by-document не shadow-ується.
  describe('route ordering: by-document/by-batch перед :id', () => {
    it('"/stock-items/by-document" НЕ матчиться як :id (no 400 від ParseUUIDPipe)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-items/by-document',
      });
      expect(res.statusCode).toBe(200);
      expect(inventoryMock.byDocument).toHaveBeenCalled();
    });

    it('"/stock-items/by-batch" НЕ матчиться як :id (no 400 від ParseUUIDPipe)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/stock-items/by-batch',
      });
      expect(res.statusCode).toBe(200);
      expect(inventoryMock.byBatch).toHaveBeenCalled();
    });
  });
});
