import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersService } from './work-orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

// ─── Mocks ────────────────────────────────────────────────

const prismaMock = {
  workOrder: {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    update: vi.fn(),
  },
  $transaction: vi.fn().mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prismaMock);
    if (Array.isArray(arg)) return Promise.all(arg);
    return undefined;
  }),
};

// Service mock — controller просто проксіює, тестуємо HTTP shape
const serviceMock = {
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  transition: vi.fn(),
  addLine: vi.fn(),
  updateLine: vi.fn(),
  removeLine: vi.fn(),
  addPart: vi.fn(),
  updatePart: vi.fn(),
  removePart: vi.fn(),
};

// Стан guards — змінюється у тестах для перевірки 401
let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx) => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: 'emp-1', orgId: 'org-1', role: 'ADMIN' };
    return true;
  }),
};

const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

describe('WorkOrders — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WorkOrdersController],
      providers: [
        { provide: WorkOrdersService, useValue: serviceMock },
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
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /work-orders', () => {
    it('повертає 200 з pagination shape', async () => {
      serviceMock.findAll.mockResolvedValueOnce({
        items: [],
        total: 0,
        page: 1,
        limit: 20,
      });
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/work-orders?page=1&limit=20',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        items: expect.any(Array),
        total: expect.any(Number),
        page: expect.any(Number),
        limit: expect.any(Number),
      });
    });

    it('приймає limit=200 без помилки 400 (для dropdown-списків)', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 200 });
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/work-orders?limit=200',
      });
      expect(res.statusCode).toBe(200);
    });

    it('відхиляє limit=201 з 400', async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/work-orders?limit=201',
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 403 коли guard не пропустив (mock canActivate=false)', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/work-orders',
      });
      jwtAllow = true;
      // Зауваження: реальний JwtAuthGuard кидає UnauthorizedException → 401,
      // але при overrideGuard().useValue() з canActivate=false NestJS повертає 403.
      // Для перевірки auth gateway цього достатньо.
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /work-orders', () => {
    it('повертає 400 без обов\'язкових полів (vehicleId, counterpartyId, branchId)', async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/work-orders',
        payload: { description: 'без обов\'язкових полів' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 коли поля не UUID', async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/work-orders',
        payload: {
          branchId: 'not-a-uuid',
          vehicleId: 'not-a-uuid',
          counterpartyId: 'not-a-uuid',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 201 + WO DTO shape при валідному body', async () => {
      jwtAllow = true;
      serviceMock.create.mockResolvedValueOnce({
        id: 'wo-uuid',
        orgId: 'org-1',
        number: 'WO-2026-0001',
        status: 'DRAFT',
        branchId: 'b-uuid',
        vehicleId: 'v-uuid',
        counterpartyId: 'c-uuid',
        totalLabor: 0,
        totalParts: 0,
        totalAmount: 0,
        paidAmount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/work-orders',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          branchId: '11111111-1111-4111-8111-111111111111',
          vehicleId: '22222222-2222-4222-8222-222222222222',
          counterpartyId: '33333333-3333-4333-8333-333333333333',
        }),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        id: expect.any(String),
        number: expect.any(String),
        status: expect.any(String),
      });
    });
  });

  describe('GET /work-orders/:id', () => {
    it('повертає 200 з детальним DTO', async () => {
      jwtAllow = true;
      serviceMock.findOne.mockResolvedValueOnce({
        id: 'wo-1', orgId: 'org-1', number: 'WO-2026-0001', status: 'DRAFT',
        branchId: 'b-1', vehicleId: 'v-1', counterpartyId: 'c-1',
        totalLabor: 0, totalParts: 0, totalAmount: 0, paidAmount: 0,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        lines: [], parts: [],
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/work-orders/wo-1',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        id: expect.any(String),
        lines: expect.any(Array),
        parts: expect.any(Array),
      });
    });
  });
});
