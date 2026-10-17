import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { PrismaService } from '../../prisma/prisma.service';
import { PurchaseListsController } from './purchase-lists.controller';
import { PurchaseListItemsController } from './purchase-list-items.controller';
import { PurchaseListsService } from './purchase-lists.service';
import { PurchaseListItemsService } from './purchase-list-items.service';
import { PurchaseShortageService } from './purchase-shortage.service';

/**
 * HTTP-контракт списків купівлі: ролі (BR-PL-015) — справжній RolesGuard, тіла — zod-схеми
 * `@sto/shared`. Сервіси — заглушки (логіку стережуть аспектні спеки).
 */

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

const lists = {
  findAll: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
  findOne: vi.fn().mockResolvedValue({}),
  create: vi.fn().mockResolvedValue({}),
  update: vi.fn().mockResolvedValue({}),
  addItem: vi.fn().mockResolvedValue({}),
  fromWorkOrder: vi.fn().mockResolvedValue({ list: {}, items: [] }),
  merge: vi.fn().mockResolvedValue({}),
  close: vi.fn().mockResolvedValue({}),
  cancel: vi.fn().mockResolvedValue({}),
  remove: vi.fn().mockResolvedValue(undefined),
  getLinkedDocuments: vi.fn().mockResolvedValue({}),
  getLinkedCounts: vi.fn().mockResolvedValue({}),
};
const items = {
  findAll: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 50 }),
  byWorkOrder: vi.fn().mockResolvedValue({ items: [], shortage: [] }),
  update: vi.fn().mockResolvedValue({}),
  split: vi.fn().mockResolvedValue([]),
  move: vi.fn().mockResolvedValue({ count: 1 }),
  bulkUpdate: vi.fn().mockResolvedValue({ count: 1 }),
  bulkCancel: vi.fn().mockResolvedValue({ count: 1 }),
  releaseReservation: vi.fn().mockResolvedValue({ released: 1, item: {} }),
};
const shortage = { shortage: vi.fn().mockResolvedValue({ items: [], truncated: false }) };

let role = 'OWNER';
const jwt = {
  canActivate: vi.fn().mockImplementation((ctx: ExecutionContext) => {
    ctx.switchToHttp().getRequest<{ user: unknown }>().user = { id: 'emp-1', orgId: 'org-1', role };
    return true;
  }),
};

describe('PurchaseLists — HTTP-контракт', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PurchaseListsController, PurchaseListItemsController],
      providers: [
        { provide: PurchaseListsService, useValue: lists },
        { provide: PurchaseListItemsService, useValue: items },
        { provide: PurchaseShortageService, useValue: shortage },
        IdempotencyInterceptor,
        { provide: PrismaService, useValue: { idempotencyKey: { create: vi.fn() } } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(jwt)
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
    role = 'OWNER';
    vi.clearAllMocks();
  });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    (app as NestFastifyApplication).inject({ method, url, payload });

  const fromWo = { workOrderId: ID, parts: [{ workOrderPartId: ID2 }] };

  // guards: BR-PL-015
  it.each([
    ['GET', '/purchase-lists', undefined],
    ['GET', `/purchase-lists/${ID}`, undefined],
    ['POST', '/purchase-lists/from-work-order', fromWo],
    ['POST', '/purchase-lists', { name: 'Тиждень' }],
    ['GET', '/purchase-list-items', undefined],
    ['GET', '/purchase-list-items/shortage', undefined],
    ['GET', `/purchase-list-items/by-work-order/${ID}`, undefined],
  ] as const)('RECEPTIONIST: %s %s → дозволено', async (method, url, payload) => {
    role = 'RECEPTIONIST';
    const res = await call(method, url, payload);
    expect(res.statusCode).toBeLessThan(300);
  });

  // guards: BR-PL-015
  it.each([
    ['PATCH', `/purchase-lists/${ID}`, { name: 'x' }],
    ['POST', `/purchase-lists/${ID}/items`, { goodId: ID, warehouseId: ID2, quantity: 1 }],
    ['POST', '/purchase-lists/merge', { targetListId: ID, sourceListIds: [ID2] }],
    ['POST', `/purchase-lists/${ID}/close`, undefined],
    ['POST', `/purchase-lists/${ID}/cancel`, undefined],
    ['DELETE', `/purchase-lists/${ID}`, undefined],
    ['PATCH', `/purchase-list-items/${ID}`, { quantity: 2 }],
    ['POST', `/purchase-list-items/${ID}/split`, { quantity: 1 }],
    ['POST', '/purchase-list-items/move', { itemIds: [ID], targetListId: ID2 }],
    ['POST', '/purchase-list-items/bulk-update', { itemIds: [ID], supplierId: ID2 }],
    ['POST', '/purchase-list-items/bulk-cancel', { itemIds: [ID] }],
    ['POST', `/purchase-list-items/${ID}/release-reservation`, undefined],
  ] as const)('RECEPTIONIST: %s %s → 403', async (method, url, payload) => {
    role = 'RECEPTIONIST';
    const res = await call(method, url, payload);
    expect(res.statusCode).toBe(403);
  });

  // guards: BR-PL-015
  it.each(['OWNER', 'ADMIN', 'STOREKEEPER'])('%s: редагування дозволено', async r => {
    role = r;
    const res = await call('POST', `/purchase-list-items/${ID}/release-reservation`);
    expect(res.statusCode).toBe(200);
    expect(items.releaseReservation).toHaveBeenCalledWith('org-1', ID, 'emp-1');
  });

  // guards: BR-PL-015
  it('MECHANIC бачить лише позиції наряду; ACCOUNTANT — нічого', async () => {
    role = 'MECHANIC';
    expect((await call('GET', `/purchase-list-items/by-work-order/${ID}`)).statusCode).toBe(200);
    expect((await call('GET', '/purchase-lists')).statusCode).toBe(403);
    role = 'ACCOUNTANT';
    expect((await call('GET', '/purchase-list-items/shortage')).statusCode).toBe(403);
  });

  it('тіла валідуються спільними zod-схемами (400 до сервісу)', async () => {
    const bad = [
      await call('POST', '/purchase-lists/from-work-order', { workOrderId: ID, parts: [] }),
      await call('POST', `/purchase-list-items/${ID}/split`, { quantity: 0 }),
      await call('POST', '/purchase-lists/merge', { targetListId: 'x', sourceListIds: [] }),
    ];
    expect(bad.map(r => r.statusCode)).toEqual([400, 400, 400]);
    expect(lists.fromWorkOrder).not.toHaveBeenCalled();
  });

  it('?supplierId=none — позиції без постачальника доходять до сервісу', async () => {
    const res = await call('GET', '/purchase-list-items?supplierId=none&status=OPEN');
    expect(res.statusCode).toBe(200);
    expect(items.findAll).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ supplierId: 'none', status: 'OPEN' }),
    );
  });
});
