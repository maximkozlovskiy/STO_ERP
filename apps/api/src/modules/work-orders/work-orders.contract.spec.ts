import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersService } from './work-orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
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
  // Bug #411: contract surface для нових linked-* endpoints
  getLinkedDocuments: vi.fn(),
  getLinkedCounts: vi.fn(),
  clone: vi.fn(),
  generatePdf: vi.fn(),
  getOrCreateShareToken: vi.fn(),
  sendEstimateSms: vi.fn(),
};

// Стан guards — змінюється у тестах для перевірки 401
let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
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
        IdempotencyInterceptor, // create-POST несе @UseInterceptors — DI має резолвити
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

    // Bug #338 regression guard — dateFrom/dateTo параметри мають прокидатись у service
    // через WorkOrderQueryDto. Аналогічний guard є у purchase-orders.contract.spec.ts.
    it('Bug #338: dateFrom + dateTo => query.dateFrom i query.dateTo v obiekt peredanomu do service.findAll', async () => {
      serviceMock.findAll.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 20 });
      jwtAllow = true;
      const callsBefore = serviceMock.findAll.mock.calls.length;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/work-orders?dateFrom=2026-01-01&dateTo=2026-01-31',
      });
      expect(res.statusCode).toBe(200);
      // Controller передає query як WorkOrderQueryDto об'єкт (не spread)
      const queryArg = serviceMock.findAll.mock.calls[callsBefore]![1] as Record<string, unknown>;
      expect(queryArg.dateFrom).toBe('2026-01-01');
      expect(queryArg.dateTo).toBe('2026-01-31');
    });
  });

  describe('POST /work-orders', () => {
    it("повертає 400 без обов'язкових полів (vehicleId, counterpartyId, branchId)", async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/work-orders',
        payload: { description: "без обов'язкових полів" },
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

    // Bug #265 (regression-guard): POST з порожніми рядками у optional enum/ISO полях
    // → 201 (не 400). @Transform(emptyToUndefined) перетворює '' на undefined ДО валідатора.
    // Без цього тесту регресія `@Transform` decorator removal пройде CI зеленою.
    it('повертає 201 коли priority/repairCategory/plannedAt/dueDate = "" → undefined у service (Bug #257-#259)', async () => {
      jwtAllow = true;
      serviceMock.create.mockResolvedValueOnce({
        id: 'wo-uuid',
        orgId: 'org-1',
        number: 'WO-2026-0002',
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
          priority: '',
          repairCategory: '',
          plannedAt: '',
          dueDate: '',
        }),
      });
      expect(res.statusCode).toBe(201);
      // class-transformer прибирає порожні поля перш ніж DTO потрапить у service
      const dtoArg = serviceMock.create.mock.calls[0]![1] as Record<string, unknown>;
      expect(dtoArg.priority).toBeUndefined();
      expect(dtoArg.repairCategory).toBeUndefined();
      expect(dtoArg.plannedAt).toBeUndefined();
      expect(dtoArg.dueDate).toBeUndefined();
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

    // Bug #426 (regression-guard): plannedHours приймається у POST + валідація `@Min(0)`.
    // Без @Transform(emptyToUndefined) на цьому полі — frontend datetime-обчислений ''
    // (`calcPlannedHours()` повертає '' коли start/end не задані) спричинить 400 при
    // створенні WO з прихованими полями.
    it('повертає 201 коли plannedHours=валідне число; 400 коли відʼємне', async () => {
      jwtAllow = true;
      serviceMock.create.mockResolvedValueOnce({
        id: 'wo-uuid',
        orgId: 'org-1',
        number: 'WO-2026-0003',
        status: 'DRAFT',
        branchId: 'b',
        vehicleId: 'v',
        counterpartyId: 'c',
        totalLabor: 0,
        totalParts: 0,
        totalAmount: 0,
        paidAmount: 0,
        plannedHours: 2.5,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const ok = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/work-orders',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          branchId: '11111111-1111-4111-8111-111111111111',
          vehicleId: '22222222-2222-4222-8222-222222222222',
          counterpartyId: '33333333-3333-4333-8333-333333333333',
          plannedHours: 2.5,
        }),
      });
      expect(ok.statusCode).toBe(201);
      const dtoArg = serviceMock.create.mock.calls.at(-1)![1] as Record<string, unknown>;
      expect(dtoArg.plannedHours).toBe(2.5);

      const bad = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/work-orders',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          branchId: '11111111-1111-4111-8111-111111111111',
          vehicleId: '22222222-2222-4222-8222-222222222222',
          counterpartyId: '33333333-3333-4333-8333-333333333333',
          plannedHours: -1,
        }),
      });
      expect(bad.statusCode).toBe(400);
    });
  });

  // Bug #426 (regression-guard): PATCH-симетрія для plannedHours/actualHours.
  // Без явного nullable-handling у DTO + сервіс — frontend reset поля (null) НЕ
  // зможе очистити збережене значення (буде "stuck" у БД).
  describe('PATCH /work-orders/:id — plannedHours/actualHours nullable handling', () => {
    const WO_ID = '11111111-1111-4111-8111-100000000001';

    it('приймає plannedHours=число + actualHours=null (clear semantics)', async () => {
      jwtAllow = true;
      serviceMock.update.mockResolvedValueOnce({
        id: WO_ID,
        orgId: 'org-1',
        number: 'WO-1',
        status: 'IN_PROGRESS',
        branchId: 'b',
        vehicleId: 'v',
        counterpartyId: 'c',
        totalLabor: 0,
        totalParts: 0,
        totalAmount: 0,
        paidAmount: 0,
        plannedHours: 3,
        actualHours: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/work-orders/${WO_ID}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ plannedHours: 3, actualHours: null }),
      });
      expect(res.statusCode).toBe(200);
      const dtoArg = serviceMock.update.mock.calls[0]![2] as Record<string, unknown>;
      expect(dtoArg.plannedHours).toBe(3);
      expect(dtoArg.actualHours).toBeNull();
    });

    it('відхиляє відʼємний actualHours (Bug #283: numeric DTO @Min guard)', async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/work-orders/${WO_ID}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ actualHours: -0.5 }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // Bug #521 regression-guard: PATCH /work-orders/:id/lines/:lineId з actualHours=null
  // повинен повертати 200 (clear semantics). Раніше DTO був @IsNumber без nullable →
  // 400 на будь-якому save() з порожнім «Год (факт.)».
  describe('Bug #521: PATCH /work-orders/:id/lines/:lineId — actualHours nullable', () => {
    const WO_ID = '11111111-1111-4111-8111-100000000001';
    const LINE_ID = '11111111-1111-4111-8111-200000000001';

    it('приймає PATCH з actualHours=null (clear semantics) → 200', async () => {
      jwtAllow = true;
      serviceMock.updateLine.mockResolvedValueOnce({
        id: LINE_ID,
        workOrderId: WO_ID,
        workId: '11111111-1111-4111-8111-300000000001',
        employeeId: '11111111-1111-4111-8111-400000000001',
        normoHours: 2,
        actualHours: null,
        price: 100,
        amount: 200,
        createdAt: new Date().toISOString(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/work-orders/${WO_ID}/lines/${LINE_ID}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ actualHours: null }),
      });
      expect(res.statusCode).toBe(200);
      const dtoArg = serviceMock.updateLine.mock.calls[0]![3] as Record<string, unknown>;
      expect(dtoArg.actualHours).toBeNull();
    });

    it('приймає PATCH з actualHours=2.5 → 200', async () => {
      jwtAllow = true;
      serviceMock.updateLine.mockResolvedValueOnce({
        id: LINE_ID,
        workOrderId: WO_ID,
        workId: '11111111-1111-4111-8111-300000000001',
        employeeId: '11111111-1111-4111-8111-400000000001',
        normoHours: 2,
        actualHours: 2.5,
        price: 100,
        amount: 200,
        createdAt: new Date().toISOString(),
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/work-orders/${WO_ID}/lines/${LINE_ID}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ actualHours: 2.5 }),
      });
      expect(res.statusCode).toBe(200);
    });

    it('відхиляє actualHours=-1 (@Min guard зберігається з ValidateIf пропуском null)', async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: `/work-orders/${WO_ID}/lines/${LINE_ID}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ actualHours: -1 }),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /work-orders/:id', () => {
    it('повертає 200 з детальним DTO', async () => {
      jwtAllow = true;
      // Bug #142: ParseUUIDPipe тепер валідує `:id` — використовуємо реальний UUID,
      // не довільний рядок типу 'wo-1', інакше отримаємо 400 до сервісу.
      const WO_ID = '00000000-0000-0000-0000-000000000001';
      serviceMock.findOne.mockResolvedValueOnce({
        id: WO_ID,
        orgId: 'org-1',
        number: 'WO-2026-0001',
        status: 'DRAFT',
        branchId: 'b-1',
        vehicleId: 'v-1',
        counterpartyId: 'c-1',
        totalLabor: 0,
        totalParts: 0,
        totalAmount: 0,
        paidAmount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lines: [],
        parts: [],
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/work-orders/${WO_ID}`,
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

  // Bug #411: contract specs для нових linked-documents / linked-counts endpoints (ca6f5830)
  describe('GET /work-orders/:id/linked-documents', () => {
    const LINKED_WO_ID = '11111111-1111-4111-8111-000000000001';

    it('повертає 200 + shape { invoices, payments, calendarSlots, warranties }', async () => {
      serviceMock.getLinkedDocuments.mockResolvedValueOnce({
        invoices: [
          { id: LINKED_WO_ID, number: 'INV-1', status: 'DRAFT', amount: 100, documentDate: null },
        ],
        payments: [],
        calendarSlots: [],
        warranties: [],
      });
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/work-orders/${LINKED_WO_ID}/linked-documents`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        invoices: expect.any(Array),
        payments: expect.any(Array),
        calendarSlots: expect.any(Array),
        warranties: expect.any(Array),
      });
      expect(serviceMock.getLinkedDocuments).toHaveBeenCalledWith('org-1', LINKED_WO_ID);
    });

    it('повертає 400 для не-UUID id', async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/work-orders/not-a-uuid/linked-documents',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /work-orders/linked-counts', () => {
    const LINKED_WO_ID = '11111111-1111-4111-8111-000000000002';

    it('повертає 200 + Record<woId, counts>', async () => {
      serviceMock.getLinkedCounts.mockResolvedValueOnce({
        [LINKED_WO_ID]: { invoices: 1, payments: 0, calendarSlots: 2, warranties: 0 },
      });
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/work-orders/linked-counts',
        payload: { workOrderIds: [LINKED_WO_ID] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body[LINKED_WO_ID]).toMatchObject({
        invoices: expect.any(Number),
        payments: expect.any(Number),
        calendarSlots: expect.any(Number),
        warranties: expect.any(Number),
      });
      expect(serviceMock.getLinkedCounts).toHaveBeenCalledWith('org-1', [LINKED_WO_ID]);
    });

    it('повертає 400 для empty array (ArrayMinSize)', async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/work-orders/linked-counts',
        payload: { workOrderIds: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 для не-UUID у array', async () => {
      jwtAllow = true;
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/work-orders/linked-counts',
        payload: { workOrderIds: ['not-uuid'] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 для array >500 (ArrayMaxSize — anti-DoS)', async () => {
      jwtAllow = true;
      const ids = Array.from({ length: 501 }, (_, i) => {
        const hex = i.toString(16).padStart(12, '0');
        return `11111111-1111-4111-8111-${hex}`;
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/work-orders/linked-counts',
        payload: { workOrderIds: ids },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
