/**
 * HTTP-контракт замовлення постачальнику: картка на перегляд бухгалтеру (BR-PO-015) і ключ
 * повторного прийому (BR-PO-014). Справжній RolesGuard за метаданими `@Roles` і справжній
 * `RequiredIdempotencyInterceptor` над таблицею ключів у пам'яті (`makeIdempotencyStore`).
 *
 * Рішення власника 2026-10-30 (TECH-DEBT (б) №41, №5): бухгалтер бачить картку замовлення лише на
 * перегляд; два однакові прийоми підряд (подвійний клік, повтор після обриву) — блокувати.
 */
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { LinesSummaryService } from '../lines-summary/lines-summary.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  IdempotencyInterceptor,
  RequiredIdempotencyInterceptor,
} from '../../common/interceptors/idempotency.interceptor';
import { makeIdempotencyStore } from '../../common/testing/idempotency-store';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const ORG = 'org-1';
const USER = 'emp-1';
const PO = '66666666-6666-4666-8666-666666666666';
const LINE = '77777777-7777-4777-8777-777777777777';

const serviceMock = {
  findOne: vi.fn(),
  getLinkedDocuments: vi.fn(),
  getLinkedCounts: vi.fn(),
  receive: vi.fn(),
  update: vi.fn(),
  transition: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  applyPricing: vi.fn(),
};

let jwtRole = 'ACCOUNTANT';
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user?: unknown }>();
    req.user = { id: USER, orgId: ORG, role: jwtRole };
    return true;
  }),
};

describe('PurchaseOrdersController — бухгалтер і ключ прийому', () => {
  let app: NestFastifyApplication;
  let store: ReturnType<typeof makeIdempotencyStore>;

  beforeAll(async () => {
    store = makeIdempotencyStore();
    const module = await Test.createTestingModule({
      controllers: [PurchaseOrdersController],
      providers: [
        { provide: PurchaseOrdersService, useValue: serviceMock },
        { provide: LinesSummaryService, useValue: {} },
        { provide: PrismaService, useValue: { idempotencyKey: store.idempotencyKey } },
        IdempotencyInterceptor,
        RequiredIdempotencyInterceptor,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => new RolesGuard(new Reflector()).canActivate(ctx),
      })
      .compile();
    const nest: INestApplication = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    nest.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await nest.init();
    app = nest as NestFastifyApplication;
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jwtRole = 'ACCOUNTANT';
    store.rows.clear();
    for (const fn of Object.values(serviceMock)) {
      fn.mockReset();
      fn.mockResolvedValue({ id: PO });
    }
  });

  describe('бухгалтер — картка замовлення лише на перегляд (BR-PO-015)', () => {
    // guards: BR-PO-015
    it.each([
      ['GET', `/purchase-orders/${PO}`, undefined],
      ['GET', `/purchase-orders/${PO}/linked-documents`, undefined],
      ['POST', '/purchase-orders/linked-counts', { ids: [PO] }],
    ])('ACCOUNTANT %s %s → 2xx', async (method, url, payload) => {
      const res = await app.inject({
        method: method as 'GET' | 'POST',
        url,
        ...(payload && { payload }),
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(200);
      expect(res.statusCode).toBeLessThan(300);
    });

    // guards: BR-PO-015
    it.each([
      ['PATCH', `/purchase-orders/${PO}`, { notes: 'x' }],
      ['POST', `/purchase-orders/${PO}/transition`, { status: 'CANCELLED' }],
      ['POST', `/purchase-orders/${PO}/receive`, { lines: [{ lineId: LINE, receivedQty: 1 }] }],
      ['DELETE', `/purchase-orders/${PO}`, undefined],
      ['POST', `/purchase-orders/${PO}/apply-pricing`, {}],
    ])('ACCOUNTANT %s %s → 403, сервіс не викликано', async (method, url, payload) => {
      const res = await app.inject({
        method: method as 'PATCH' | 'POST' | 'DELETE',
        url,
        headers: { 'idempotency-key': randomUUID() },
        ...(payload && { payload }),
      });
      expect(res.statusCode).toBe(403);
      for (const fn of Object.values(serviceMock)) expect(fn).not.toHaveBeenCalled();
    });

    // guards: BR-PO-015
    it('RECEPTIONIST картки замовлення не відкриває (403)', async () => {
      jwtRole = 'RECEPTIONIST';
      const res = await app.inject({ method: 'GET', url: `/purchase-orders/${PO}` });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('повторний прийом — ключ обов’язковий (BR-PO-014)', () => {
    const receive = (key: string | null, qty = 1) =>
      app.inject({
        method: 'POST',
        url: `/purchase-orders/${PO}/receive`,
        payload: { lines: [{ lineId: LINE, receivedQty: qty }] },
        ...(key && { headers: { 'idempotency-key': key } }),
      });

    beforeEach(() => {
      jwtRole = 'STOREKEEPER';
      let n = 0;
      serviceMock.receive.mockImplementation(() => Promise.resolve({ id: PO, call: ++n }));
    });

    // guards: BR-PO-014
    it('без Idempotency-Key → 400, прийому немає', async () => {
      const res = await receive(null);
      expect(res.statusCode).toBe(400);
      expect(serviceMock.receive).not.toHaveBeenCalled();
    });

    // guards: BR-PO-014
    it('два однакові прийоми з тим самим ключем → товар прийнято раз, друга відповідь — та сама', async () => {
      const key = randomUUID();
      const first = await receive(key);
      const second = await receive(key);

      expect(first.statusCode).toBeLessThan(300);
      expect(second.statusCode).toBeLessThan(300);
      expect(second.json()).toEqual(first.json());
      expect(serviceMock.receive).toHaveBeenCalledTimes(1);
    });

    // Справжній другий прийом — нове відкриття вікна прийому, новий ключ.
    // guards: BR-PO-014
    it('новий ключ → другий прийом виконується', async () => {
      await receive(randomUUID());
      await receive(randomUUID());
      expect(serviceMock.receive).toHaveBeenCalledTimes(2);
    });

    // guards: BR-PO-014
    it('той самий ключ з іншою кількістю → 422, другого прийому немає', async () => {
      const key = randomUUID();
      await receive(key, 1);
      const res = await receive(key, 2);
      expect(res.statusCode).toBe(422);
      expect(serviceMock.receive).toHaveBeenCalledTimes(1);
    });
  });
});
