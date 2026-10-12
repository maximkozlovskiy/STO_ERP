import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PricingRulesController } from './pricing-rules.controller';
import { PricingService } from './pricing.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

// УВАГА: усі UUID у фікстурах цього файлу мусять бути валідним v4
// (13-й символ «4», 17-й з {8,9,a,b}) — ParseUUIDPipe у NestJS 12 перевіряє
// версію і відхиляє інші значення з 400.

const prismaMock = {
  pricingRule: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  pricingRuleTier: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  pricingRuleGood: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    findMany: vi.fn().mockResolvedValue([]),
  },
  goodCategory: {
    findFirst: vi.fn(),
  },
  good: {
    findFirst: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
  },
  brand: {
    findFirst: vi.fn(),
  },
  counterparty: {
    findFirst: vi.fn(),
  },
  $transaction: vi.fn().mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => Promise<unknown>)(prismaMock);
    }
    return Promise.all(arg as Promise<unknown>[]);
  }),
};

/**
 * Запис правила = `create` (повертає id) + перечитування з повним include. Тест задає рядок раз:
 * хелпер розкладає його на обидва виклики й доповнює полями, які include додає завжди.
 */
function mockSavedRule(row: Record<string, unknown>): void {
  const full: Record<string, unknown> = {
    goodCategoryId: null,
    supplierId: null,
    category: null,
    brand: null,
    supplier: null,
    tiers: [],
    goods: [],
    _count: { goods: 0 },
    ...row,
  };
  prismaMock.pricingRule.create.mockResolvedValueOnce({ id: full.id });
  prismaMock.pricingRule.findFirstOrThrow.mockResolvedValueOnce(full);
}

const RULE_ID = '00000000-0000-4000-8000-000000000001';
const GOOD_1 = '22222222-2222-4222-8222-222222222201';
const GOOD_2 = '22222222-2222-4222-8222-222222222202';
const CATEGORY = '33333333-3333-4333-8333-333333333301';
const BRAND = '11111111-1111-4111-8111-111111111199';

/** Наявне правило, як його читає PATCH (з лічильником товарів списку). */
function existingRule(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RULE_ID,
    orgId: 'org-1',
    name: 'r',
    type: 'PERCENT',
    brandId: null,
    goodId: null,
    goodCategoryId: null,
    goodCategory: null,
    goodType: null,
    supplierId: null,
    percentValue: 30,
    _count: { goods: 0 },
    ...patch,
  };
}

const pricingServiceMock = {
  applyRuleToGoods: vi.fn().mockResolvedValue(42),
};

// C1b: тримаємо посилання на audit-mock, щоб асертити аргументи record() (money-critical).
const auditMock = { record: vi.fn().mockResolvedValue(undefined) };

let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    // AuthenticatedUser (jwt.strategy.validate) має `id` (мапиться з payload.sub), НЕ `sub`.
    // Контролер читає @CurrentUser().id для аудиту — мок мусить дзеркалити реальний shape.
    req.user = { id: 'emp-1', sub: 'emp-1', orgId: 'org-1', role: 'OWNER' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

describe('PricingRules — HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PricingRulesController],
      providers: [
        { provide: PricingService, useValue: pricingServiceMock },
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditService, useValue: auditMock },
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

  beforeEach(() => {
    jwtAllow = true;
    vi.clearAllMocks();
  });

  describe('GET /pricing-rules', () => {
    it('Bug #18: повертає paginated shape { items, total, page, limit }', async () => {
      prismaMock.$transaction.mockResolvedValueOnce([[], 0]);
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/pricing-rules',
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

    it('повертає 403 коли guard не пропустив', async () => {
      jwtAllow = false;
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/pricing-rules',
      });
      expect(res.statusCode).toBe(403);
    });

    // ── Bug #565: ParseUUIDPipe guard на ?supplierId= ─────────────────────────
    // sto-review Cycle 2 додав ParseUUIDPipe({ optional: true }) щоб довільний рядок
    // (`?supplierId=DROP+TABLE`) валідувався class-validator-ом, а не Prisma WHERE.
    // Без contract-тесту регресія можлива при будь-якому рефакторингу контролера.
    it('Bug #565: GET ?supplierId=not-uuid → 400 (ParseUUIDPipe guard)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/pricing-rules?supplierId=not-a-uuid',
      });
      expect(res.statusCode).toBe(400);
      // Prisma findMany НЕ викликаний — pipe блокує до execution
      expect(prismaMock.pricingRule.findMany).not.toHaveBeenCalled();
    });

    it('Bug #565: GET ?supplierId=<UUID> → 200 (фільтрація працює)', async () => {
      prismaMock.$transaction.mockResolvedValueOnce([[], 0]);
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/pricing-rules?supplierId=11111111-1111-4111-8111-111111111199',
      });
      expect(res.statusCode).toBe(200);
    });

    it('Bug #565: GET без supplierId → 200 (optional pipe)', async () => {
      prismaMock.$transaction.mockResolvedValueOnce([[], 0]);
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/pricing-rules',
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /pricing-rules', () => {
    it("повертає 400 без обов'язкових полів (name, type)", async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/pricing-rules',
        payload: { priority: 10 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 коли у goodIds є не UUID', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/pricing-rules',
        payload: {
          name: 'Test',
          type: 'PERCENT',
          goodIds: [GOOD_1, 'not-a-uuid'],
          percentValue: 30,
        },
      });
      expect(res.statusCode).toBe(400);
    });

    // Старе поле `goodId` прибрано з контракту: мовчки проігнорувати його означало б створити
    // правило «на весь асортимент» замість правила на товар.
    it('повертає 400 на застаріле поле goodId (його замінив список goodIds)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/pricing-rules',
        payload: { name: 'Test', type: 'PERCENT', goodId: GOOD_1, percentValue: 30 },
      });
      expect(res.statusCode).toBe(400);
      expect(prismaMock.pricingRule.create).not.toHaveBeenCalled();
    });

    it('повертає 400 коли type не з enum', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/pricing-rules',
        payload: {
          name: 'Test',
          type: 'INVALID_TYPE',
          percentValue: 30,
        },
      });
      expect(res.statusCode).toBe(400);
    });

    // Bug #265 (regression-guard): POST з порожнім рядком у optional goodType-enum
    // → 201 (не 400). @Transform(emptyToUndefined) перетворює '' на undefined ДО валідатора.
    it('повертає 201 коли goodType="" → undefined у service (Bug #264)', async () => {
      mockSavedRule({
        id: 'rule-uuid',
        orgId: 'org-1',
        name: 'Universal +20%',
        type: 'PERCENT',
        priority: 10,
        goodId: null,
        goodCategory: null,
        goodType: null,
        brandId: null,
        percentValue: 20,
        fixedAmount: null,
        fixedPrice: null,
        roundTo: null,
        isActive: true,
        createdAt: new Date(),
        good: null,
        brand: null,
        tiers: [],
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/pricing-rules',
        payload: {
          name: 'Universal +20%',
          type: 'PERCENT',
          goodType: '',
          percentValue: 20,
        },
      });
      expect(res.statusCode).toBe(201);
      // Перевіряємо, що prisma.create отримав «типу немає» (null), а не порожній рядок
      const createCall = prismaMock.pricingRule.create.mock.calls[0]?.[0] as {
        data?: Record<string, unknown>;
      };
      expect(createCall?.data?.goodType).toBeNull();
    });

    it('повертає 201 + dto shape для валідного PERCENT правила', async () => {
      mockSavedRule({
        id: 'rule-uuid',
        orgId: 'org-1',
        name: 'Запчастини +35%',
        type: 'PERCENT',
        priority: 10,
        goodId: null,
        goodCategory: null,
        goodType: 'SPARE_PART',
        brandId: null,
        percentValue: 35,
        fixedAmount: null,
        fixedPrice: null,
        roundTo: null,
        isActive: true,
        createdAt: new Date(),
        good: null,
        brand: null,
        tiers: [],
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/pricing-rules',
        payload: {
          name: 'Запчастини +35%',
          type: 'PERCENT',
          goodType: 'SPARE_PART',
          percentValue: 35,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        type: 'PERCENT',
        priority: expect.any(Number),
        isActive: expect.any(Boolean),
      });
    });

    // ── Bug #186: brandId cross-tenant FK validation ───────────────────────
    it('Bug #186: POST з brandId з ЦІЄЇ org → 201 (brand знайдено)', async () => {
      prismaMock.brand.findFirst.mockResolvedValueOnce({ id: 'brand-uuid' });
      mockSavedRule({
        id: 'rule-uuid',
        orgId: 'org-1',
        name: 'Bosch +25%',
        type: 'PERCENT',
        priority: 5,
        goodId: null,
        goodCategory: null,
        goodType: null,
        brandId: 'brand-uuid',
        percentValue: 25,
        fixedAmount: null,
        fixedPrice: null,
        roundTo: null,
        isActive: true,
        createdAt: new Date(),
        good: null,
        brand: { id: 'brand-uuid', name: 'Bosch' },
        tiers: [],
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/pricing-rules',
        payload: {
          name: 'Bosch +25%',
          type: 'PERCENT',
          brandId: '11111111-1111-4111-8111-111111111199',
          percentValue: 25,
        },
      });
      expect(res.statusCode).toBe(201);
      // Перевіряємо що org-scoped перевірка справді викликалась
      expect(prismaMock.brand.findFirst).toHaveBeenCalledWith({
        where: { id: '11111111-1111-4111-8111-111111111199', orgId: 'org-1', deletedAt: null },
        select: { id: true },
      });
    });

    it('Bug #186: POST з brandId з ЧУЖОЇ org → 404 «Бренд не знайдено»', async () => {
      prismaMock.brand.findFirst.mockResolvedValueOnce(null); // інша org
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/pricing-rules',
        payload: {
          name: 'Cross-tenant attempt',
          type: 'PERCENT',
          brandId: '11111111-1111-4111-8111-111111111199',
          percentValue: 25,
        },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json<{ message: string }>();
      expect(body.message).toMatch(/Бренд не знайдено/);
      // pricingRule.create НЕ викликаний — write блокується ДО запису
      expect(prismaMock.pricingRule.create).not.toHaveBeenCalled();
    });

    // ── Bug #565: supplierId cross-tenant FK validation (Bug #186 pattern) ────
    it('Bug #565: POST з supplierId з ЧУЖОЇ org → 404 «Постачальника не знайдено»', async () => {
      prismaMock.counterparty.findFirst.mockResolvedValueOnce(null); // інша org
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/pricing-rules',
        payload: {
          name: 'Cross-tenant supplier attempt',
          type: 'PERCENT',
          supplierId: '11111111-1111-4111-8111-111111111199',
          percentValue: 25,
        },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json<{ message: string }>();
      expect(body.message).toMatch(/Постачальника не знайдено/);
      expect(prismaMock.pricingRule.create).not.toHaveBeenCalled();
    });

    it('Bug #565: POST з невалідним supplierId UUID → 400 (class-validator)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/pricing-rules',
        payload: {
          name: 'Bad UUID',
          type: 'PERCENT',
          supplierId: 'not-a-uuid',
          percentValue: 25,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(prismaMock.counterparty.findFirst).not.toHaveBeenCalled();
      expect(prismaMock.pricingRule.create).not.toHaveBeenCalled();
    });
  });

  describe('POST /pricing-rules/:id/apply-all', () => {
    it('повертає 200 + { updated, message }', async () => {
      prismaMock.pricingRule.findFirst.mockResolvedValueOnce({ id: 'rule-uuid' });
      pricingServiceMock.applyRuleToGoods.mockResolvedValueOnce(42);
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/pricing-rules/00000000-0000-4000-8000-000000000001/apply-all',
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        updated: expect.any(Number),
        message: expect.any(String),
      });
    });

    it('повертає 404 для неіснуючого правила', async () => {
      prismaMock.pricingRule.findFirst.mockResolvedValueOnce(null);
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/pricing-rules/00000000-0000-4000-8000-000000000002/apply-all',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PATCH /pricing-rules/:id — Bug #27 validation', () => {
    // ValidationPipe rejects payload before controller body runs — no findFirst mock needed.
    it("повертає 400 при від'ємному percentValue (PATCH тепер має @Min(0))", async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: '/pricing-rules/00000000-0000-4000-8000-000000000001',
        payload: { percentValue: -50 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("повертає 400 при від'ємному fixedPrice", async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: '/pricing-rules/00000000-0000-4000-8000-000000000001',
        payload: { fixedPrice: -100 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 при percentValue > 10000', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: '/pricing-rules/00000000-0000-4000-8000-000000000001',
        payload: { percentValue: 99999 },
      });
      expect(res.statusCode).toBe(400);
    });

    // ── Bug #186: PATCH brandId cross-tenant ───────────────────────────────
    it('Bug #186: PATCH з brandId з ЧУЖОЇ org → 404 «Бренд не знайдено»', async () => {
      // existing rule знайдено
      prismaMock.pricingRule.findFirst.mockResolvedValueOnce(existingRule());
      // brand для ЧУЖОЇ org → null
      prismaMock.brand.findFirst.mockResolvedValueOnce(null);
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: '/pricing-rules/00000000-0000-4000-8000-000000000001',
        payload: { brandId: '11111111-1111-4111-8111-111111111199' },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json<{ message: string }>();
      expect(body.message).toMatch(/Бренд не знайдено/);
      // правило НЕ записане
      expect(prismaMock.pricingRule.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /pricing-rules/:id', () => {
    it('повертає 204 для успішного soft-delete', async () => {
      // Bug #191 pattern: контролер тепер використовує updateMany з orgId для defense-in-depth
      prismaMock.pricingRule.updateMany.mockResolvedValueOnce({ count: 1 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'DELETE',
        url: '/pricing-rules/00000000-0000-4000-8000-000000000001',
      });
      expect(res.statusCode).toBe(204);
      // Перевіряємо що org-scoped where використано
      expect(prismaMock.pricingRule.updateMany).toHaveBeenCalledWith({
        where: { id: '00000000-0000-4000-8000-000000000001', orgId: 'org-1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('повертає 404 для неіснуючого правила', async () => {
      prismaMock.pricingRule.updateMany.mockResolvedValueOnce({ count: 0 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'DELETE',
        url: '/pricing-rules/00000000-0000-4000-8000-000000000002',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── C1b audit: money-critical правила ціни пишуть AuditEvent з коректними аргументами ──
  // Регресія-gap: раніше жоден тест не асертив, що auditRule → audit.record викликається
  // з (orgId, 'PricingRule', id, action, userId). Load-bearing (аудит цінових змін —
  // фінансовий compliance-слід), тому фіксуємо контракт.
  describe('C1b audit: record() аргументи', () => {
    it('CREATE → record(orgId, PricingRule, id, CREATE, userId) ПІСЛЯ inline-write', async () => {
      mockSavedRule({
        id: 'rule-created',
        orgId: 'org-1',
        name: 'Ауд-правило',
        type: 'PERCENT',
        priority: 10,
        goodId: null,
        goodCategory: null,
        goodType: 'SPARE_PART',
        brandId: null,
        percentValue: 15,
        fixedAmount: null,
        fixedPrice: null,
        roundTo: null,
        isActive: true,
        createdAt: new Date(),
        good: null,
        brand: null,
        supplier: null,
        tiers: [],
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/pricing-rules',
        payload: { name: 'Ауд-правило', type: 'PERCENT', goodType: 'SPARE_PART', percentValue: 15 },
      });
      expect(res.statusCode).toBe(201);
      await Promise.resolve(); // best-effort .catch мікротаск
      // audit ПІСЛЯ write — id береться з create-результату (не було б доступне до write)
      expect(prismaMock.pricingRule.create).toHaveBeenCalled();
      expect(auditMock.record).toHaveBeenCalledTimes(1);
      const args = auditMock.record.mock.calls[0];
      expect(args[0]).toBe('org-1'); // orgId
      expect(args[1]).toBe('PricingRule'); // entityType
      expect(args[2]).toBe('rule-created'); // entityId — з create-результату
      expect(args[3]).toBe('CREATE'); // action
      expect(args[4]).toBe('emp-1'); // userId (з mockJwtGuard req.user.sub)
    });

    it('DELETE (успіх) → record(orgId, PricingRule, id, DELETE, userId)', async () => {
      prismaMock.pricingRule.updateMany.mockResolvedValueOnce({ count: 1 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'DELETE',
        url: '/pricing-rules/00000000-0000-4000-8000-000000000009',
      });
      expect(res.statusCode).toBe(204);
      await Promise.resolve();
      expect(auditMock.record).toHaveBeenCalledTimes(1);
      const args = auditMock.record.mock.calls[0];
      expect(args[1]).toBe('PricingRule');
      expect(args[2]).toBe('00000000-0000-4000-8000-000000000009');
      expect(args[3]).toBe('DELETE');
      expect(args[4]).toBe('emp-1');
    });

    it('DELETE (404, count=0) → record() НЕ викликається (аудит лише за реального write)', async () => {
      prismaMock.pricingRule.updateMany.mockResolvedValueOnce({ count: 0 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'DELETE',
        url: '/pricing-rules/00000000-0000-4000-8000-00000000000a',
      });
      expect(res.statusCode).toBe(404);
      await Promise.resolve();
      expect(auditMock.record).not.toHaveBeenCalled();
    });
  });

  // ─── BR-GOOD-009 / BR-GOOD-010: список товарів і категорія з довідника ──────────
  //
  // Mutation-verify:
  //  · прибрати `hasGoods`-гілку з normalizeScope → кейс «список товарів очищає бренд…» падає;
  //  · прибрати порівняння `foundGoods !== goodIds.length` → кейс про чужий товар падає;
  //  · прибрати `orgId` з рядків createMany → кейс «рядки списку несуть orgId» падає;
  //  · прибрати `dropGoods` → кейс «бренд замість списку» падає;
  //  · `goodCategory: categoryTouched ? null : existing.goodCategory` → завжди existing →
  //    кейс «вибір категорії прибирає стару текстову» падає; → завжди null → кейс «не чіпали» падає.
  describe('список товарів і категорія правила', () => {
    const inject = (method: 'POST' | 'PATCH' | 'GET', url: string, payload?: unknown) =>
      (app as NestFastifyApplication).inject({ method, url, ...(payload ? { payload } : {}) });
    const base = { name: 'Список', type: 'PERCENT', percentValue: 10 };
    const savedRow = (patch: Record<string, unknown> = {}) => ({
      id: RULE_ID,
      orgId: 'org-1',
      name: 'Список',
      type: 'PERCENT',
      priority: 10,
      goodId: null,
      goodCategory: null,
      goodType: null,
      brandId: null,
      percentValue: 10,
      fixedAmount: null,
      fixedPrice: null,
      roundTo: null,
      isActive: true,
      createdAt: new Date(),
      ...patch,
    });
    const updateData = () =>
      (prismaMock.pricingRule.updateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> })
        .data;

    beforeEach(() => {
      prismaMock.pricingRule.updateMany.mockResolvedValue({ count: 1 });
    });

    // guards: BR-GOOD-009
    it('POST зі списком: рядки списку несуть orgId, повтори зведено, у відповіді — лічильник', async () => {
      prismaMock.good.count.mockResolvedValueOnce(2);
      mockSavedRule(
        savedRow({
          _count: { goods: 2 },
          goods: [
            { good: { id: GOOD_1, internalCode: 'K1', name: 'Фільтр', sku: 'A1', brand: null } },
            {
              good: {
                id: GOOD_2,
                internalCode: null,
                name: 'Колодки',
                sku: null,
                brand: { name: 'Bosch' },
              },
            },
          ],
        }),
      );
      const res = await inject('POST', '/pricing-rules', {
        ...base,
        goodIds: [GOOD_1, GOOD_2, GOOD_1],
      });
      expect(res.statusCode).toBe(201);
      expect(prismaMock.pricingRuleGood.createMany).toHaveBeenCalledWith({
        data: [
          { orgId: 'org-1', pricingRuleId: RULE_ID, goodId: GOOD_1 },
          { orgId: 'org-1', pricingRuleId: RULE_ID, goodId: GOOD_2 },
        ],
        skipDuplicates: true,
      });
      expect(res.json()).toMatchObject({
        goodsCount: 2,
        goodsPreview: [
          { id: GOOD_1, internalCode: 'K1', name: 'Фільтр', sku: 'A1', brandName: null },
          { id: GOOD_2, name: 'Колодки', brandName: 'Bosch' },
        ],
      });
    });

    // guards: BR-GOOD-009
    it('POST: список товарів очищає бренд, категорію й тип — область має один вимір', async () => {
      prismaMock.good.count.mockResolvedValueOnce(1);
      mockSavedRule(savedRow({ _count: { goods: 1 } }));
      const res = await inject('POST', '/pricing-rules', {
        ...base,
        goodIds: [GOOD_1],
        brandId: BRAND,
        goodCategoryId: CATEGORY,
        goodType: 'SPARE_PART',
      });
      expect(res.statusCode).toBe(201);
      const data = (
        prismaMock.pricingRule.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
      ).data;
      expect(data).toMatchObject({ brandId: null, goodCategoryId: null, goodType: null });
      // Очищений вимір не перевіряється: чужий бренд не має валити збереження списку.
      expect(prismaMock.brand.findFirst).not.toHaveBeenCalled();
      expect(prismaMock.goodCategory.findFirst).not.toHaveBeenCalled();
    });

    // guards: BR-GOOD-009
    it('POST: товар чужої організації або видалений у списку → 404, правило не створено', async () => {
      prismaMock.good.count.mockResolvedValueOnce(1); // знайдено 1 із 2
      const res = await inject('POST', '/pricing-rules', { ...base, goodIds: [GOOD_1, GOOD_2] });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ message: string }>().message).toMatch(
        /Частину товарів списку не знайдено \(1\)/,
      );
      expect(prismaMock.good.count).toHaveBeenCalledWith({
        where: { orgId: 'org-1', deletedAt: null, id: { in: [GOOD_1, GOOD_2] } },
      });
      expect(prismaMock.pricingRule.create).not.toHaveBeenCalled();
    });

    // guards: BR-GOOD-009
    it('POST: понад 5000 товарів у списку → 400', async () => {
      const ids = Array.from(
        { length: 5001 },
        (_, i) => `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
      );
      const res = await inject('POST', '/pricing-rules', { ...base, goodIds: ids });
      expect(res.statusCode).toBe(400);
      expect(prismaMock.pricingRule.create).not.toHaveBeenCalled();
    });

    // guards: BR-GOOD-010
    it('POST з категорією: перевіряється в межах організації, чужа → 404', async () => {
      prismaMock.goodCategory.findFirst.mockResolvedValueOnce(null);
      const res = await inject('POST', '/pricing-rules', { ...base, goodCategoryId: CATEGORY });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ message: string }>().message).toMatch(/Категорію товарів не знайдено/);
      expect(prismaMock.goodCategory.findFirst).toHaveBeenCalledWith({
        where: { id: CATEGORY, orgId: 'org-1', deletedAt: null },
        select: { id: true },
      });
      expect(prismaMock.pricingRule.create).not.toHaveBeenCalled();
    });

    // guards: BR-GOOD-010
    it('POST з категорією своєї організації → 201, назва категорії у відповіді', async () => {
      prismaMock.goodCategory.findFirst.mockResolvedValueOnce({ id: CATEGORY });
      mockSavedRule(
        savedRow({
          goodCategoryId: CATEGORY,
          category: { id: CATEGORY, name: 'Гальмівна система' },
        }),
      );
      const res = await inject('POST', '/pricing-rules', {
        ...base,
        goodCategoryId: CATEGORY,
        goodType: 'SPARE_PART',
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        goodCategoryId: CATEGORY,
        goodCategoryName: 'Гальмівна система',
        goodsCount: 0,
      });
      const data = (
        prismaMock.pricingRule.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
      ).data;
      // Категорія точніша за тип — тип очищено.
      expect(data).toMatchObject({ goodCategoryId: CATEGORY, goodType: null });
    });

    // guards: BR-GOOD-009
    it('PATCH з новим списком: старий список заміщується цілком у тій самій транзакції', async () => {
      prismaMock.pricingRule.findFirst.mockResolvedValueOnce(
        existingRule({ _count: { goods: 3 } }),
      );
      prismaMock.good.count.mockResolvedValueOnce(1);
      prismaMock.pricingRule.findFirstOrThrow.mockResolvedValueOnce(
        savedRow({
          category: null,
          brand: null,
          supplier: null,
          tiers: [],
          goods: [],
          _count: { goods: 1 },
        }),
      );
      const res = await inject('PATCH', `/pricing-rules/${RULE_ID}`, { goodIds: [GOOD_2] });
      expect(res.statusCode).toBe(200);
      expect(prismaMock.pricingRuleGood.deleteMany).toHaveBeenCalledWith({
        where: { orgId: 'org-1', pricingRuleId: RULE_ID },
      });
      expect(prismaMock.pricingRuleGood.createMany).toHaveBeenCalledWith({
        data: [{ orgId: 'org-1', pricingRuleId: RULE_ID, goodId: GOOD_2 }],
        skipDuplicates: true,
      });
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    });

    // guards: BR-GOOD-009
    it('PATCH: порожній список і бренд — список знято, правило стає правилом бренду', async () => {
      prismaMock.pricingRule.findFirst.mockResolvedValueOnce(
        existingRule({ _count: { goods: 3 } }),
      );
      prismaMock.brand.findFirst.mockResolvedValueOnce({ id: BRAND });
      prismaMock.pricingRule.findFirstOrThrow.mockResolvedValueOnce(
        savedRow({
          category: null,
          brand: null,
          supplier: null,
          tiers: [],
          goods: [],
          _count: { goods: 0 },
        }),
      );
      const res = await inject('PATCH', `/pricing-rules/${RULE_ID}`, {
        goodIds: [],
        brandId: BRAND,
      });
      expect(res.statusCode).toBe(200);
      expect(prismaMock.pricingRuleGood.deleteMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.pricingRuleGood.createMany).not.toHaveBeenCalled();
      expect(updateData()).toMatchObject({ brandId: BRAND, goodId: null });
    });

    // guards: BR-GOOD-009
    it('PATCH без поля goodIds не чіпає список; бренд, надісланий до правила зі списком, очищено', async () => {
      prismaMock.pricingRule.findFirst.mockResolvedValueOnce(
        existingRule({ _count: { goods: 3 } }),
      );
      prismaMock.pricingRule.findFirstOrThrow.mockResolvedValueOnce(
        savedRow({
          category: null,
          brand: null,
          supplier: null,
          tiers: [],
          goods: [],
          _count: { goods: 3 },
        }),
      );
      const res = await inject('PATCH', `/pricing-rules/${RULE_ID}`, {
        name: 'Нова назва',
        brandId: BRAND,
      });
      expect(res.statusCode).toBe(200);
      expect(prismaMock.pricingRuleGood.deleteMany).not.toHaveBeenCalled();
      expect(updateData()).toMatchObject({ name: 'Нова назва', brandId: null });
    });

    // guards: BR-GOOD-010
    it('PATCH: вибір категорії з довідника прибирає стару текстову категорію', async () => {
      prismaMock.pricingRule.findFirst.mockResolvedValueOnce(
        existingRule({ goodCategory: 'Мастила' }),
      );
      prismaMock.goodCategory.findFirst.mockResolvedValueOnce({ id: CATEGORY });
      prismaMock.pricingRule.findFirstOrThrow.mockResolvedValueOnce(
        savedRow({
          category: null,
          brand: null,
          supplier: null,
          tiers: [],
          goods: [],
          _count: { goods: 0 },
        }),
      );
      const res = await inject('PATCH', `/pricing-rules/${RULE_ID}`, { goodCategoryId: CATEGORY });
      expect(res.statusCode).toBe(200);
      expect(updateData()).toMatchObject({ goodCategoryId: CATEGORY, goodCategory: null });
    });

    // guards: BR-GOOD-010
    it('PATCH, що категорію не чіпає, лишає стару текстову категорію працювати', async () => {
      prismaMock.pricingRule.findFirst.mockResolvedValueOnce(
        existingRule({ goodCategory: 'Мастила' }),
      );
      prismaMock.pricingRule.findFirstOrThrow.mockResolvedValueOnce(
        savedRow({
          category: null,
          brand: null,
          supplier: null,
          tiers: [],
          goods: [],
          _count: { goods: 0 },
        }),
      );
      const res = await inject('PATCH', `/pricing-rules/${RULE_ID}`, { priority: 5 });
      expect(res.statusCode).toBe(200);
      expect(updateData()).toMatchObject({ goodCategoryId: null, goodCategory: 'Мастила' });
    });

    // guards: BR-GOOD-010
    it('PATCH goodCategoryId: null знімає категорію (і стару текстову теж)', async () => {
      prismaMock.pricingRule.findFirst.mockResolvedValueOnce(
        existingRule({ goodCategory: 'Мастила' }),
      );
      prismaMock.pricingRule.findFirstOrThrow.mockResolvedValueOnce(
        savedRow({
          category: null,
          brand: null,
          supplier: null,
          tiers: [],
          goods: [],
          _count: { goods: 0 },
        }),
      );
      const res = await inject('PATCH', `/pricing-rules/${RULE_ID}`, { goodCategoryId: null });
      expect(res.statusCode).toBe(200);
      expect(updateData()).toMatchObject({ goodCategoryId: null, goodCategory: null });
      expect(prismaMock.goodCategory.findFirst).not.toHaveBeenCalled();
    });

    // guards: BR-GOOD-009
    it('GET :id/goods — повний список товарів правила, лише живі товари', async () => {
      prismaMock.pricingRule.findFirst.mockResolvedValueOnce({ id: RULE_ID });
      prismaMock.pricingRuleGood.findMany.mockResolvedValueOnce([
        {
          good: {
            id: GOOD_1,
            internalCode: 'K1',
            name: 'Фільтр',
            sku: 'A1',
            brand: { name: 'Mann' },
          },
        },
      ]);
      const res = await inject('GET', `/pricing-rules/${RULE_ID}/goods`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        items: [{ id: GOOD_1, internalCode: 'K1', name: 'Фільтр', sku: 'A1', brandName: 'Mann' }],
        total: 1,
      });
      expect(prismaMock.pricingRuleGood.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgId: 'org-1', pricingRuleId: RULE_ID, good: { deletedAt: null } },
        }),
      );
    });

    // guards: BR-GOOD-009
    it('GET :id/goods для чужого правила → 404, список не читається', async () => {
      prismaMock.pricingRule.findFirst.mockResolvedValueOnce(null);
      const res = await inject('GET', `/pricing-rules/${RULE_ID}/goods`);
      expect(res.statusCode).toBe(404);
      expect(prismaMock.pricingRuleGood.findMany).not.toHaveBeenCalled();
    });
  });
});
