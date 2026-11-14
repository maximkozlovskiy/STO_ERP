/**
 * «Додати всю категорію» у пікері товарів правила (BR-GOOD-009, блок 4 №21):
 * `GET /pricing-rules/category-goods?goodCategoryId=` віддає ВСІ живі товари категорії з усіма
 * нащадками — без ліміту сторінки пошуку (50); понад `PRICING_RULE_MAX_GOODS` — 400 з лімітом.
 *
 * Справжні `PricingRulesService` і `PricingService` (дерево категорій), фейкова Prisma ВИКОНУЄ
 * `where` товарів і категорій: тест про відбір, тож заготовка відповіді нічого б не довела.
 *
 * Mutation-verify (2026-11-14):
 *  · `goodCategoryId: { in: categoryIds }` → `goodCategoryId` (лише сама категорія) → кейс «з
 *    нащадками» падає;
 *  · `take: PRICING_RULE_MAX_GOODS` → `take: 50` → кейс «понад 50» падає;
 *  · `count > PRICING_RULE_MAX_GOODS` → `>=` → кейс «рівно ліміт» падає; перевірку прибрати →
 *    кейс «понад ліміт → 400» падає;
 *  · прибрати `deletedAt: null` у `where` товарів → кейс «видалені й чужі не потрапляють» падає.
 */
import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PRICING_RULE_MAX_GOODS } from '@sto/shared';
import { PricingRulesService } from './pricing-rules.service';
import { PricingRulesController } from './pricing-rules.controller';
import { PricingService } from './pricing.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

const ORG = 'org-1';
const ROOT = '33333333-3333-4333-8333-333333333301';
const CHILD = '33333333-3333-4333-8333-333333333302';
const GRANDCHILD = '33333333-3333-4333-8333-333333333303';
const OTHER = '33333333-3333-4333-8333-333333333304';
const ALIEN = '33333333-3333-4333-8333-333333333305';

type Category = { id: string; orgId: string; parentId: string | null; deletedAt: Date | null };
type Good = {
  id: string;
  orgId: string;
  name: string;
  internalCode: string | null;
  sku: string | null;
  goodCategoryId: string | null;
  deletedAt: Date | null;
  brand: { name: string } | null;
};

const CATEGORIES: Category[] = [
  { id: ROOT, orgId: ORG, parentId: null, deletedAt: null },
  { id: CHILD, orgId: ORG, parentId: ROOT, deletedAt: null },
  { id: GRANDCHILD, orgId: ORG, parentId: CHILD, deletedAt: null },
  { id: OTHER, orgId: ORG, parentId: null, deletedAt: null },
  { id: ALIEN, orgId: 'org-2', parentId: null, deletedAt: null },
];

const good = (id: string, goodCategoryId: string, patch: Partial<Good> = {}): Good => ({
  id,
  orgId: ORG,
  name: id,
  internalCode: null,
  sku: null,
  goodCategoryId,
  deletedAt: null,
  brand: null,
  ...patch,
});

type GoodWhere = { orgId: string; deletedAt?: null; goodCategoryId?: string | { in: string[] } };

/** Фейкова Prisma: `where` категорій і товарів виконується, а не ігнорується. */
function fakePrisma(goods: Good[]) {
  const goodMatches = (g: Good, w: GoodWhere) =>
    g.orgId === w.orgId &&
    (w.deletedAt === undefined || g.deletedAt === w.deletedAt) &&
    (w.goodCategoryId === undefined ||
      (typeof w.goodCategoryId === 'string'
        ? g.goodCategoryId === w.goodCategoryId
        : w.goodCategoryId.in.includes(g.goodCategoryId ?? '')));
  return {
    goodCategory: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; orgId: string; deletedAt: null } }) =>
          CATEGORIES.find(
            c => c.id === where.id && c.orgId === where.orgId && c.deletedAt === where.deletedAt,
          ) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { orgId: string; deletedAt: null } }) =>
        CATEGORIES.filter(c => c.orgId === where.orgId && c.deletedAt === where.deletedAt).map(
          c => ({ id: c.id, parentId: c.parentId }),
        ),
      ),
    },
    good: {
      count: vi.fn(
        async ({ where }: { where: GoodWhere }) => goods.filter(g => goodMatches(g, where)).length,
      ),
      findMany: vi.fn(async ({ where, take }: { where: GoodWhere; take: number }) =>
        goods
          .filter(g => goodMatches(g, where))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, take)
          .map(({ id, internalCode, name, sku, brand }) => ({
            id,
            internalCode,
            name,
            sku,
            brand,
          })),
      ),
    },
  };
}

async function build(prisma: ReturnType<typeof fakePrisma>) {
  const module = await Test.createTestingModule({
    controllers: [PricingRulesController],
    providers: [
      PricingRulesService,
      PricingService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: { record: vi.fn() } },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({
      canActivate: (ctx: { switchToHttp: () => { getRequest: () => { user?: unknown } } }) => {
        ctx.switchToHttp().getRequest().user = { id: 'emp-1', orgId: ORG, role: 'OWNER' };
        return true;
      },
    })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    .compile();
  return module;
}

// guards: BR-GOOD-009
describe('GET /pricing-rules/category-goods — усі товари категорії (№21)', () => {
  let service: PricingRulesService;
  let prisma: ReturnType<typeof fakePrisma>;

  const setup = async (goods: Good[]) => {
    prisma = fakePrisma(goods);
    service = (await build(prisma)).get(PricingRulesService);
  };

  it('товари категорії й усіх нащадків; інша категорія — ні', async () => {
    await setup([
      good('a-root', ROOT),
      good('b-child', CHILD, { sku: 'SKU-B', brand: { name: 'Bosch' } }),
      good('c-grand', GRANDCHILD),
      good('d-other', OTHER),
    ]);

    const res = await service.findCategoryGoods(ORG, ROOT);

    expect(res.total).toBe(3);
    expect(res.items).toEqual([
      { id: 'a-root', internalCode: null, name: 'a-root', sku: null, brandName: null },
      { id: 'b-child', internalCode: null, name: 'b-child', sku: 'SKU-B', brandName: 'Bosch' },
      { id: 'c-grand', internalCode: null, name: 'c-grand', sku: null, brandName: null },
    ]);
  });

  it('видалені товари й товари чужої організації не потрапляють', async () => {
    await setup([
      good('live', CHILD),
      good('deleted', CHILD, { deletedAt: new Date('2026-01-01T00:00:00Z') }),
      good('alien', CHILD, { orgId: 'org-2' }),
    ]);

    const res = await service.findCategoryGoods(ORG, ROOT);

    expect(res.items.map(g => g.id)).toEqual(['live']);
  });

  it('понад 50 товарів (сторінка пошуку) — віддаються всі', async () => {
    await setup(
      Array.from({ length: 120 }, (_, i) => good(`g${String(i).padStart(3, '0')}`, CHILD)),
    );

    const res = await service.findCategoryGoods(ORG, ROOT);

    expect(res.total).toBe(120);
    expect(res.items).toHaveLength(120);
  });

  it('рівно ліміт списку правила — ще дозволено', async () => {
    await setup(
      Array.from({ length: PRICING_RULE_MAX_GOODS }, (_, i) =>
        good(`g${String(i).padStart(5, '0')}`, ROOT),
      ),
    );

    const res = await service.findCategoryGoods(ORG, ROOT);

    expect(res.total).toBe(PRICING_RULE_MAX_GOODS);
  });

  it('понад ліміт списку правила → 400 з кількістю й лімітом, товари не читаються', async () => {
    await setup(
      Array.from({ length: PRICING_RULE_MAX_GOODS + 1 }, (_, i) =>
        good(`g${String(i).padStart(5, '0')}`, GRANDCHILD),
      ),
    );

    const run = service.findCategoryGoods(ORG, ROOT);

    await expect(run).rejects.toBeInstanceOf(BadRequestException);
    await expect(run).rejects.toThrow(
      `У категорії ${PRICING_RULE_MAX_GOODS + 1} товарів, а список правила вміщує не більше ${PRICING_RULE_MAX_GOODS}`,
    );
    expect(prisma.good.findMany).not.toHaveBeenCalled();
  });

  it('категорія чужої організації → 404, товари не читаються', async () => {
    await setup([good('x', ALIEN, { orgId: 'org-2' })]);

    await expect(service.findCategoryGoods(ORG, ALIEN)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.good.count).not.toHaveBeenCalled();
  });

  describe('HTTP', () => {
    let app: NestFastifyApplication;

    beforeEach(async () => {
      prisma = fakePrisma([good('a', ROOT)]);
      app = (await build(prisma)).createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
      );
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it('200 зі списком товарів; маршрут не перехоплюють маршрути з `:id`', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/pricing-rules/category-goods?goodCategoryId=${ROOT}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        items: [{ id: 'a', internalCode: null, name: 'a', sku: null, brandName: null }],
        total: 1,
      });
    });

    it('goodCategoryId не UUID або відсутній → 400 до запиту в базу', async () => {
      const bad = await app.inject({
        method: 'GET',
        url: '/pricing-rules/category-goods?goodCategoryId=abc',
      });
      const missing = await app.inject({ method: 'GET', url: '/pricing-rules/category-goods' });
      expect(bad.statusCode).toBe(400);
      expect(missing.statusCode).toBe(400);
      expect(prisma.goodCategory.findFirst).not.toHaveBeenCalled();
    });
  });
});
