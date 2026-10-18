import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { PrismaService } from '../../prisma/prisma.service';
import { SupplierAdapterRegistry } from './adapters/supplier-adapter-registry';
import {
  SupplierConnectionsController,
  SupplierProvidersController,
} from './connections/supplier-connections.controller';
import { SupplierConnectionsService } from './connections/supplier-connections.service';
import { SupplierCatalogService } from './catalog/supplier-catalog.service';
import {
  SupplierItemOffersController,
  SupplierOffersController,
} from './offers/supplier-offers.controller';
import { SupplierOffersService } from './offers/supplier-offers.service';
import { SupplierAllocationService } from './strategy/supplier-allocation.service';
import { SupplierOrdersController } from './orders/supplier-orders.controller';
import { SupplierOrdersService } from './orders/supplier-orders.service';

/**
 * HTTP-контракт постачальників API: ролі (BR-SCON-001, BR-SCON-009, BR-SOFR-002) — справжній
 * RolesGuard, тіла — zod-схеми `@sto/shared`. Сервіси — заглушки (логіку стережуть аспектні спеки).
 */
const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

const connections = {
  findAll: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  findOne: vi.fn().mockResolvedValue({}),
  create: vi.fn().mockResolvedValue({}),
  update: vi.fn().mockResolvedValue({}),
  remove: vi.fn().mockResolvedValue(undefined),
  requestVerify: vi.fn().mockResolvedValue({ connection: {}, queueUnavailable: false }),
};
const catalog = { requestSync: vi.fn().mockResolvedValue({ queued: true }) };
const offers = {
  search: vi.fn().mockResolvedValue({ id: ID, items: [] }),
  getBatch: vi.fn().mockResolvedValue({ id: ID, items: [] }),
  itemOffers: vi.fn().mockResolvedValue({ itemId: ID, requests: [] }),
  chooseOffer: vi.fn().mockResolvedValue({ id: ID }),
  clearOffer: vi.fn().mockResolvedValue({ id: ID }),
  procurementSettings: vi.fn().mockResolvedValue({ defaultStrategy: 'OPTIMAL' }),
};
const allocation = { allocate: vi.fn().mockResolvedValue({ items: [], applied: false }) };
const orders = {
  getState: vi.fn().mockResolvedValue({ orders: [] }),
  send: vi.fn().mockResolvedValue({ orders: [] }),
  requestPoll: vi.fn().mockResolvedValue({ orders: [] }),
  releaseUnconfirmed: vi.fn().mockResolvedValue({ released: 1, state: {} }),
};
const registry = { list: vi.fn().mockReturnValue([]) };

let role = 'OWNER';
const jwt = {
  canActivate: vi.fn().mockImplementation((ctx: ExecutionContext) => {
    ctx.switchToHttp().getRequest<{ user: unknown }>().user = { id: 'emp-1', orgId: 'org-1', role };
    return true;
  }),
};

describe('Постачальники API — HTTP-контракт', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [
        SupplierProvidersController,
        SupplierConnectionsController,
        SupplierOffersController,
        SupplierItemOffersController,
        SupplierOrdersController,
      ],
      providers: [
        { provide: SupplierConnectionsService, useValue: connections },
        { provide: SupplierCatalogService, useValue: catalog },
        { provide: SupplierOffersService, useValue: offers },
        { provide: SupplierAllocationService, useValue: allocation },
        { provide: SupplierOrdersService, useValue: orders },
        { provide: SupplierAdapterRegistry, useValue: registry },
        IdempotencyInterceptor,
        {
          provide: PrismaService,
          useValue: { idempotencyKey: { create: vi.fn(), findFirst: vi.fn() } },
        },
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

  const adminOnly = [
    ['GET', '/supplier-providers', undefined],
    ['GET', '/supplier-connections', undefined],
    ['GET', `/supplier-connections/${ID}`, undefined],
    ['POST', '/supplier-connections', { counterpartyId: ID, provider: 'UTR' }],
    ['PATCH', `/supplier-connections/${ID}`, { priority: 5 }],
    ['DELETE', `/supplier-connections/${ID}`, undefined],
    ['POST', `/supplier-connections/${ID}/verify`, undefined],
    ['POST', `/supplier-connections/${ID}/catalog-sync`, undefined],
  ] as const;

  // guards: BR-SCON-001
  it.each(adminOnly)(
    'STOREKEEPER: %s %s → 403 (підключення — лише власник і адміністратор)',
    async (method, url, payload) => {
      role = 'STOREKEEPER';
      expect((await call(method, url, payload)).statusCode).toBe(403);
    },
  );

  // guards: BR-SCON-001
  it.each(['OWNER', 'ADMIN'])('%s: підключення доступні', async r => {
    role = r;
    for (const [method, url, payload] of adminOnly) {
      expect((await call(method, url, payload)).statusCode, `${method} ${url}`).toBeLessThan(300);
    }
  });

  const procurement = [
    ['POST', '/supplier-offers/search', { itemIds: [ID] }],
    ['GET', `/supplier-offers/batches/${ID}`, undefined],
    [
      'POST',
      '/supplier-offers/allocate',
      { batchId: ID, strategy: 'CHEAP', dryRun: true, overrideManual: true },
    ],
    ['GET', '/supplier-offers/settings', undefined],
    ['GET', `/purchase-list-items/${ID}/offers`, undefined],
    ['POST', `/purchase-list-items/${ID}/choose-offer`, { offerId: ID2 }],
    ['DELETE', `/purchase-list-items/${ID}/offer`, undefined],
    ['POST', `/purchase-orders/${ID}/supplier-api/send`, undefined],
    ['POST', `/purchase-orders/${ID}/supplier-api/poll`, undefined],
    ['POST', `/purchase-orders/${ID}/supplier-api/release-unconfirmed`, undefined],
  ] as const;

  // guards: BR-SOFR-002
  // guards: BR-SCON-009
  it.each(['RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT'])(
    '%s: пропозиції й відправка → 403',
    async r => {
      role = r;
      for (const [method, url, payload] of procurement) {
        expect((await call(method, url, payload)).statusCode, `${method} ${url}`).toBe(403);
      }
    },
  );

  // guards: BR-SOFR-002
  // guards: BR-SCON-009
  it('STOREKEEPER: пропозиції, автопідбір і відправка доступні; роль доходить до сервісу', async () => {
    role = 'STOREKEEPER';
    for (const [method, url, payload] of procurement) {
      expect((await call(method, url, payload)).statusCode, `${method} ${url}`).toBeLessThan(300);
    }
    expect(offers.search).toHaveBeenCalledWith(
      'org-1',
      { itemIds: [ID] },
      { userId: 'emp-1', role: 'STOREKEEPER' },
    );
    expect(orders.send).toHaveBeenCalledWith('org-1', ID, 'STOREKEEPER');
    // Прапорець «перезаписати ручний вибір» доходить до сервісу (BR-SOFR-009).
    expect(allocation.allocate).toHaveBeenCalledWith(
      'org-1',
      { batchId: ID, strategy: 'CHEAP', dryRun: true, overrideManual: true },
      'STOREKEEPER',
    );
    expect(offers.procurementSettings).toHaveBeenCalledWith('org-1');
  });

  it('стан передачі в API бачить і бухгалтер; приймальня — ні', async () => {
    role = 'ACCOUNTANT';
    expect((await call('GET', `/purchase-orders/${ID}/supplier-api`)).statusCode).toBe(200);
    role = 'RECEPTIONIST';
    expect((await call('GET', `/purchase-orders/${ID}/supplier-api`)).statusCode).toBe(403);
  });

  it('тіла валідуються спільними zod-схемами (400 до сервісу)', async () => {
    const bad = [
      await call('POST', '/supplier-connections', { counterpartyId: 'x', provider: 'NOPE' }),
      await call('POST', '/supplier-connections', {
        counterpartyId: ID,
        provider: 'UTR',
        priority: 5000,
      }),
      await call('POST', '/supplier-offers/search', { itemIds: [] }),
      await call('POST', '/supplier-offers/allocate', { batchId: ID, strategy: 'RANDOM' }),
      await call('POST', `/purchase-list-items/${ID}/choose-offer`, { offerId: 'nope' }),
    ];
    expect(bad.map(r => r.statusCode)).toEqual([400, 400, 400, 400, 400]);
    expect(connections.create).not.toHaveBeenCalled();
    expect(offers.search).not.toHaveBeenCalled();
  });

  it('відповіді «поставлено в чергу» — 202', async () => {
    expect((await call('POST', `/supplier-connections/${ID}/verify`)).statusCode).toBe(202);
    expect((await call('POST', '/supplier-offers/search', { itemIds: [ID] })).statusCode).toBe(202);
    expect((await call('POST', `/purchase-orders/${ID}/supplier-api/send`)).statusCode).toBe(202);
  });
});
