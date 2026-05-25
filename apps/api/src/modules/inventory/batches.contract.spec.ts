import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BatchesController } from './batches.controller';
import { BatchService } from './batch.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const prismaMock = {
  good: {
    findFirst: vi.fn(),
  },
  priceHistory: {
    findMany: vi.fn(),
  },
};

const batchServiceMock = {
  getBatchesForGood: vi.fn(),
  getAvgCost: vi.fn(),
};

let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx) => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: 'emp-1', orgId: 'org-1', role: 'STOREKEEPER' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

describe('Batches — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BatchesController],
      providers: [
        { provide: BatchService, useValue: batchServiceMock },
        { provide: PrismaService, useValue: prismaMock },
      ],
    })
      .overrideGuard(JwtAuthGuard).useValue(mockJwtGuard)
      .overrideGuard(RolesGuard).useValue(mockRolesGuard)
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
  });

  describe('GET /batches/lookup', () => {
    it('повертає 200 + lookup shape { good, avgCostPrice, batches, priceHistory }', async () => {
      prismaMock.good.findFirst.mockResolvedValueOnce({
        id: 'g-1', name: 'Олива 5W40', sku: 'OIL-001', unit: 'л', salePrice: 250,
      });
      batchServiceMock.getBatchesForGood.mockResolvedValueOnce([
        {
          id: 'b-1', goodId: 'g-1', warehouseId: 'wh-1', purchaseOrderLineId: null,
          batchNumber: null, expiryDate: null, receivedQty: 10, remainingQty: 8,
          costPrice: 100, salePrice: 250, isActive: true, createdAt: new Date(),
          purchaseOrderNumber: null,
        },
      ]);
      prismaMock.priceHistory.findMany.mockResolvedValueOnce([]);
      batchServiceMock.getAvgCost.mockResolvedValueOnce(100);

      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/batches/lookup?goodId=00000000-0000-0000-0000-000000000001',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        good: expect.objectContaining({ id: expect.any(String), name: expect.any(String) }),
        avgCostPrice: expect.any(Number),
        batches: expect.any(Array),
        priceHistory: expect.any(Array),
      });
    });

    it('Bug #21: повертає 404 коли good не знайдено (а не null body)', async () => {
      prismaMock.good.findFirst.mockResolvedValueOnce(null);
      batchServiceMock.getBatchesForGood.mockResolvedValueOnce([]);
      prismaMock.priceHistory.findMany.mockResolvedValueOnce([]);
      batchServiceMock.getAvgCost.mockResolvedValueOnce(0);

      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/batches/lookup?goodId=00000000-0000-0000-0000-000000000099',
      });
      expect(res.statusCode).toBe(404);
    });

    it('Bug #16: getAvgCost викликається з warehouseId=undefined коли query-param відсутній', async () => {
      prismaMock.good.findFirst.mockResolvedValueOnce({
        id: 'g-1', name: 'X', sku: null, unit: 'шт', salePrice: 100,
      });
      batchServiceMock.getBatchesForGood.mockResolvedValueOnce([]);
      prismaMock.priceHistory.findMany.mockResolvedValueOnce([]);
      batchServiceMock.getAvgCost.mockResolvedValueOnce(0);

      await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/batches/lookup?goodId=00000000-0000-0000-0000-000000000001',
      });
      // Не передаємо порожній рядок — undefined → агрегація по всіх складах.
      expect(batchServiceMock.getAvgCost).toHaveBeenCalledWith('org-1', expect.any(String), undefined);
    });

    it('повертає 403 коли guard не пропустив', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/batches/lookup?goodId=00000000-0000-0000-0000-000000000001',
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
