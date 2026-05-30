import { INestApplication, ValidationPipe, NotFoundException } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

// Bug #189: regression-захист для POST /:id/apply-pricing HTTP-contract
const serviceMock = {
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  transition: vi.fn(),
  receive: vi.fn(),
  applyPricing: vi.fn(),
};

let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx) => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { id: 'emp-1', orgId: 'org-1', role: 'OWNER' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

describe('PurchaseOrders — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PurchaseOrdersController],
      providers: [
        { provide: PurchaseOrdersService, useValue: serviceMock },
      ],
    })
      .overrideGuard(JwtAuthGuard).useValue(mockJwtGuard)
      .overrideGuard(RolesGuard).useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
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

  const VALID_UUID = '11111111-1111-4111-8111-111111111111';

  describe('POST /purchase-orders/:id/apply-pricing', () => {
    it('Bug #189: 200 + dto shape { updated, details } для валідного id', async () => {
      serviceMock.applyPricing.mockResolvedValueOnce({
        updated: 2,
        details: [
          { goodId: 'g-1', goodName: 'A', costPrice: 100, oldSalePrice: 130, newSalePrice: 150 },
          { goodId: 'g-2', goodName: 'B', costPrice: 50, oldSalePrice: 70, newSalePrice: 80 },
        ],
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: `/purchase-orders/${VALID_UUID}/apply-pricing`,
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        updated: 2,
        details: expect.arrayContaining([
          expect.objectContaining({ goodId: expect.any(String), newSalePrice: expect.any(Number) }),
        ]),
      });
      // Перевіряємо що service викликаний з (orgId, id)
      expect(serviceMock.applyPricing).toHaveBeenCalledWith('org-1', VALID_UUID);
    });

    it('Bug #189: 400 для не-UUID id (ParseUUIDPipe)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/purchase-orders/not-a-uuid/apply-pricing',
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.applyPricing).not.toHaveBeenCalled();
    });

    it('Bug #189: 403 без JWT', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: `/purchase-orders/${VALID_UUID}/apply-pricing`,
      });
      expect(res.statusCode).toBe(403);
      expect(serviceMock.applyPricing).not.toHaveBeenCalled();
    });

    it('Bug #189: 404 коли PO не знайдено (service кидає NotFoundException)', async () => {
      serviceMock.applyPricing.mockRejectedValueOnce(new NotFoundException('Замовлення не знайдено'));
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: `/purchase-orders/${VALID_UUID}/apply-pricing`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toBe('Замовлення не знайдено');
    });

    it('Bug #189: 200 + порожній details для PO без змін', async () => {
      serviceMock.applyPricing.mockResolvedValueOnce({ updated: 0, details: [] });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: `/purchase-orders/${VALID_UUID}/apply-pricing`,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ updated: 0, details: [] });
    });
  });
});
