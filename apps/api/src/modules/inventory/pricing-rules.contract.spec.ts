import { INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PricingRulesController } from './pricing-rules.controller';
import { PricingService } from './pricing.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

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
  good: {
    findFirst: vi.fn(),
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

const pricingServiceMock = {
  calculateSalePrice: vi.fn(),
  applyRuleToGoods: vi.fn().mockResolvedValue(42),
};

let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { sub: 'emp-1', orgId: 'org-1', role: 'OWNER' };
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

    it('повертає 400 коли goodId не UUID', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/pricing-rules',
        payload: {
          name: 'Test',
          type: 'PERCENT',
          goodId: 'not-a-uuid',
          percentValue: 30,
        },
      });
      expect(res.statusCode).toBe(400);
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
      prismaMock.pricingRule.create.mockResolvedValueOnce({
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
      // Перевіряємо що prisma.create отримав goodType undefined (а не '')
      const createCall = prismaMock.pricingRule.create.mock.calls[0]?.[0] as {
        data?: Record<string, unknown>;
      };
      expect(createCall?.data?.goodType).toBeUndefined();
    });

    it('повертає 201 + dto shape для валідного PERCENT правила', async () => {
      prismaMock.pricingRule.create.mockResolvedValueOnce({
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
      prismaMock.pricingRule.create.mockResolvedValueOnce({
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
        url: '/pricing-rules/00000000-0000-0000-0000-000000000001/apply-all',
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
        url: '/pricing-rules/00000000-0000-0000-0000-000000000002/apply-all',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PATCH /pricing-rules/:id — Bug #27 validation', () => {
    // ValidationPipe rejects payload before controller body runs — no findFirst mock needed.
    it("повертає 400 при від'ємному percentValue (PATCH тепер має @Min(0))", async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: '/pricing-rules/00000000-0000-0000-0000-000000000001',
        payload: { percentValue: -50 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("повертає 400 при від'ємному fixedPrice", async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: '/pricing-rules/00000000-0000-0000-0000-000000000001',
        payload: { fixedPrice: -100 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 при percentValue > 10000', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: '/pricing-rules/00000000-0000-0000-0000-000000000001',
        payload: { percentValue: 99999 },
      });
      expect(res.statusCode).toBe(400);
    });

    // ── Bug #186: PATCH brandId cross-tenant ───────────────────────────────
    it('Bug #186: PATCH з brandId з ЧУЖОЇ org → 404 «Бренд не знайдено»', async () => {
      // existing rule знайдено
      prismaMock.pricingRule.findFirst.mockResolvedValueOnce({
        id: 'rule-uuid',
        orgId: 'org-1',
        brandId: null,
        goodId: null,
        goodCategory: null,
        goodType: null,
        percentValue: 30,
        name: 'r',
      });
      // brand для ЧУЖОЇ org → null
      prismaMock.brand.findFirst.mockResolvedValueOnce(null);
      const res = await (app as NestFastifyApplication).inject({
        method: 'PATCH',
        url: '/pricing-rules/00000000-0000-0000-0000-000000000001',
        payload: { brandId: '11111111-1111-4111-8111-111111111199' },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json<{ message: string }>();
      expect(body.message).toMatch(/Бренд не знайдено/);
      // pricingRule.update НЕ викликаний
      expect(prismaMock.pricingRule.update).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /pricing-rules/:id', () => {
    it('повертає 204 для успішного soft-delete', async () => {
      // Bug #191 pattern: контролер тепер використовує updateMany з orgId для defense-in-depth
      prismaMock.pricingRule.updateMany.mockResolvedValueOnce({ count: 1 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'DELETE',
        url: '/pricing-rules/00000000-0000-0000-0000-000000000001',
      });
      expect(res.statusCode).toBe(204);
      // Перевіряємо що org-scoped where використано
      expect(prismaMock.pricingRule.updateMany).toHaveBeenCalledWith({
        where: { id: '00000000-0000-0000-0000-000000000001', orgId: 'org-1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('повертає 404 для неіснуючого правила', async () => {
      prismaMock.pricingRule.updateMany.mockResolvedValueOnce({ count: 0 });
      const res = await (app as NestFastifyApplication).inject({
        method: 'DELETE',
        url: '/pricing-rules/00000000-0000-0000-0000-000000000002',
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
