import {
  INestApplication,
  ValidationPipe,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
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
  canActivate: vi.fn().mockImplementation(ctx => {
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
      providers: [{ provide: PurchaseOrdersService, useValue: serviceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
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
      serviceMock.applyPricing.mockRejectedValueOnce(
        new NotFoundException('Замовлення не знайдено'),
      );
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

    // Bug #202: defense-in-depth status guard (commit c1dc5dd) — лише RECEIVED/PARTIAL
    it('Bug #202 status guard: 400 коли PO у DRAFT/ORDERED (service кидає BadRequestException)', async () => {
      serviceMock.applyPricing.mockRejectedValueOnce(
        new BadRequestException(
          'Розцінити можна лише отримані товари (статус RECEIVED або PARTIAL)',
        ),
      );
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: `/purchase-orders/${VALID_UUID}/apply-pricing`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/RECEIVED.*PARTIAL/);
      expect(serviceMock.applyPricing).toHaveBeenCalledWith('org-1', VALID_UUID);
    });
  });

  // Bug #328 regression guard for commit c7f15dd — controller must forward
  // ?q= і ?showDeleted= до service. Раніше параметри ігнорувались, frontend
  // фільтр у /purchase-orders сторінці тихо нічого не робив.
  describe('GET /purchase-orders (showDeleted + q forwarding)', () => {
    beforeEach(() => {
      serviceMock.findAll.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
    });

    // Bug #340: controller.findAll прокидує 10 args у service.findAll
    // (orgId, page, limit, status, q, showDeleted, dateFrom, dateTo, sortBy, sortDir)
    // — sortBy/sortDir додано у 65db856 (column sorting feature).
    it('showDeleted=true → service.findAll отримує true', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/purchase-orders?showDeleted=true',
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.findAll).toHaveBeenCalledWith(
        'org-1',
        1,
        20,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it('showDeleted відсутній → service.findAll отримує false (showDeleted === "true" check)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/purchase-orders',
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.findAll).toHaveBeenCalledWith(
        'org-1',
        1,
        20,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it('q=PO-001 → service.findAll отримує query string', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/purchase-orders?q=PO-001&status=DRAFT',
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.findAll).toHaveBeenCalledWith(
        'org-1',
        1,
        20,
        'DRAFT',
        'PO-001',
        false,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it('page=2&limit=50&q=test&showDeleted=true → всі параметри прокинуті', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/purchase-orders?page=2&limit=50&q=test&showDeleted=true&status=RECEIVED',
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.findAll).toHaveBeenCalledWith(
        'org-1',
        2,
        50,
        'RECEIVED',
        'test',
        true,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    });

    it('dateFrom + dateTo → service.findAll отримує дати', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/purchase-orders?dateFrom=2026-01-01&dateTo=2026-01-31',
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.findAll).toHaveBeenCalledWith(
        'org-1',
        1,
        20,
        undefined,
        undefined,
        false,
        '2026-01-01',
        '2026-01-31',
        undefined,
        undefined,
      );
    });
  });

  // Bug #328 regression guard — deletedAt має бути серіалізовано у відповіді
  describe('GET /purchase-orders — deletedAt у DTO response', () => {
    it('toDto результат у items містить deletedAt поле', async () => {
      const itemWithDeleted = {
        id: VALID_UUID,
        number: 'PO-001',
        status: 'DRAFT',
        deletedAt: new Date('2026-01-15').toISOString(),
        totalAmount: 100,
        supplierName: 'Test',
      };
      serviceMock.findAll.mockResolvedValueOnce({
        items: [itemWithDeleted],
        total: 1,
        page: 1,
        limit: 20,
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/purchase-orders?showDeleted=true',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items[0]).toHaveProperty('deletedAt');
      expect(body.items[0].deletedAt).toBe('2026-01-15T00:00:00.000Z');
    });
  });

  // Bug #477: UpdatePurchaseOrderDto має `@ValidateIf((_, v) => v !== null) @IsUUID()`
  // для contractId, що дозволяє frontend надсилати explicit null для clear контракту.
  // Якщо @ValidateIf видалити → null триггерить @IsUUID → 400 → frontend не може зняти договір.
  describe('PATCH /purchase-orders/:id (contractId nullable)', () => {
    beforeEach(() => {
      serviceMock.update.mockResolvedValue({
        id: VALID_UUID,
        status: 'DRAFT',
        contractId: null,
        contractNumber: null,
      });
    });

    it('Bug #477: PATCH з contractId=null → 200, service.update викликаний з dto.contractId=null', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/purchase-orders/${VALID_UUID}`,
        payload: { contractId: null },
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.update).toHaveBeenCalledWith(
        'org-1',
        VALID_UUID,
        expect.objectContaining({ contractId: null }),
      );
    });

    it('Bug #477: PATCH з contractId=valid UUID → 200, service.update отримує UUID', async () => {
      const CONTRACT_ID = '99999999-9999-4999-8999-999999999999';
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/purchase-orders/${VALID_UUID}`,
        payload: { contractId: CONTRACT_ID },
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.update).toHaveBeenCalledWith(
        'org-1',
        VALID_UUID,
        expect.objectContaining({ contractId: CONTRACT_ID }),
      );
    });

    it('Bug #477: PATCH з contractId="" → emptyToUndefined → service отримує undefined', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/purchase-orders/${VALID_UUID}`,
        payload: { contractId: '' },
      });
      expect(res.statusCode).toBe(200);
      // emptyToUndefined transform → '' → undefined → IsOptional skips IsUUID
      const callArgs = serviceMock.update.mock.calls[0][2];
      expect(callArgs.contractId).toBeUndefined();
    });

    it('Bug #477: PATCH з contractId="not-a-uuid" → 400 (IsUUID validation)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/purchase-orders/${VALID_UUID}`,
        payload: { contractId: 'not-a-uuid' },
      });
      expect(res.statusCode).toBe(400);
      expect(serviceMock.update).not.toHaveBeenCalled();
    });

    // Bug #475 contract layer: PATCH з supplierId/warehouseId переадресовується у service
    it('Bug #475: PATCH з supplierId+warehouseId+contractId=null → всі поля forward до service', async () => {
      const NEW_SUPPLIER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const NEW_WAREHOUSE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/purchase-orders/${VALID_UUID}`,
        payload: {
          supplierId: NEW_SUPPLIER,
          warehouseId: NEW_WAREHOUSE,
          contractId: null,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMock.update).toHaveBeenCalledWith(
        'org-1',
        VALID_UUID,
        expect.objectContaining({
          supplierId: NEW_SUPPLIER,
          warehouseId: NEW_WAREHOUSE,
          contractId: null,
        }),
      );
    });
  });
});
