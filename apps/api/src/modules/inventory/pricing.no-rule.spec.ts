/**
 * Розцінка без жодного правила НЕ змінює ціну продажу (BR-GOOD-011, блок 4 №17, рішення власника
 * 2026-10-30). Тут — шляхи з СПРАВЖНІМ `PricingService` (вибір правила не замокано): «Застосувати
 * до всіх» і прийом партії. «Розцінити» закупівлі — `purchase-orders.pricing.spec.ts`, «Розцінити
 * список» — `xlsx.service.spec.ts`.
 *
 * Фейкова Prisma виконує `where` правил (org, `isActive`, `deletedAt`) — інакше тест «правило
 * постачальника без постачальника не діє» перевіряв би заготовку, а не відбір.
 *
 * Mutation-verify (2026-11-14):
 *  · `planPrices`: `if (!winner) { noRule++; continue; }` → `newPrice = costPrice` (як було) →
 *    кейс «Застосувати до всіх» падає (ціна 100 замість 140 лишається, історія пишеться);
 *  · `computePriceFromRules` без правила повертає `costPrice` → обидва кейси прийому партії падають;
 *  · `batch`: `computePriceFromRules(…) ?? dto.costPrice` (старий відкат на собівартість) → обидва
 *    кейси «без правила» прийому партії падають.
 */
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PricingService } from './pricing.service';
import { BatchService } from './batch.service';
import { PrismaService } from '../../prisma/prisma.service';

const ORG = 'org-1';

type RuleRow = {
  id: string;
  orgId: string;
  name: string;
  isActive: boolean;
  deletedAt: Date | null;
  supplierId: string | null;
  brandId: string | null;
  goodCategoryId: string | null;
  goodCategory: string | null;
  goodType: string | null;
  type: string;
  percentValue: number;
  fixedAmount: null;
  fixedPrice: null;
  roundTo: null;
  tiers: never[];
  _count: { goods: number };
};

const rule = (patch: Partial<RuleRow>): RuleRow => ({
  id: 'r',
  orgId: ORG,
  name: 'r',
  isActive: true,
  deletedAt: null,
  supplierId: null,
  brandId: null,
  goodCategoryId: null,
  goodCategory: null,
  goodType: null,
  type: 'PERCENT',
  percentValue: 40,
  fixedAmount: null,
  fixedPrice: null,
  roundTo: null,
  tiers: [],
  _count: { goods: 0 },
  ...patch,
});

/** Фейкова Prisma: правила відбираються за `where` так, як це зробила б база. */
function fakePrisma(rules: RuleRow[], goods: Array<Record<string, unknown>>) {
  const matches = (r: RuleRow, where: Record<string, unknown>) =>
    r.orgId === where.orgId &&
    (where.deletedAt === undefined || r.deletedAt === where.deletedAt) &&
    (where.isActive === undefined || r.isActive === where.isActive) &&
    (where.id === undefined || r.id === where.id);
  const prisma = {
    pricingRule: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rules.filter(r => matches(r, where)),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          rules.find(r => matches(r, where)) ?? null,
      ),
    },
    pricingRuleGood: { findMany: vi.fn().mockResolvedValue([]) },
    goodCategory: { findMany: vi.fn().mockResolvedValue([]) },
    good: {
      findMany: vi.fn(async ({ where }: { where: { orgId: string; brandId?: string } }) =>
        goods.filter(
          g => g.orgId === where.orgId && (!where.brandId || g.brandId === where.brandId),
        ),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; orgId: string } }) =>
          goods.find(g => g.id === where.id && g.orgId === where.orgId) ?? null,
      ),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    priceHistory: {
      create: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    stockBatch: { create: vi.fn().mockResolvedValue({ id: 'batch-1' }) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  return prisma;
}

const goodRow = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  orgId: ORG,
  name: id,
  purchasePrice: 100,
  salePrice: 125,
  category: null,
  goodCategoryId: null,
  goodType: null,
  brandId: null,
  unitId: null,
  ...patch,
});

async function build(prisma: ReturnType<typeof fakePrisma>) {
  const module = await Test.createTestingModule({
    providers: [PricingService, BatchService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return { pricing: module.get(PricingService), batch: module.get(BatchService) };
}

describe('Розцінка без правила не змінює ціну (№17)', () => {
  let prisma: ReturnType<typeof fakePrisma>;

  // guards: BR-GOOD-011
  describe('«Застосувати до всіх»', () => {
    beforeEach(() => {
      prisma = fakePrisma(
        [
          // Застосовують правило постачальника: без постачальника воно не діє (BR-GOOD-012).
          rule({ id: 'sup', name: 'Постачальник +60%', supplierId: 'sup-1', percentValue: 60 }),
          // Загальне правило лише на бренд b1; вимкнене «весь асортимент» участі не бере.
          rule({ id: 'brand', name: 'Бренд +40%', brandId: 'b1' }),
          rule({ id: 'off', name: 'Вимкнене', isActive: false, percentValue: 90 }),
          rule({ id: 'alien', orgId: 'org-2', name: 'Чуже', percentValue: 90 }),
        ],
        [goodRow('g-brand', { brandId: 'b1' }), goodRow('g-free')],
      );
    });

    it('товар без жодного правила лишає ціну, історії немає; у підсумку — «без правила»', async () => {
      const { pricing } = await build(prisma);

      const res = await pricing.applyRuleToGoods(ORG, 'sup');

      expect(res).toEqual({ updated: 1, noRule: 1 });
      const written = prisma.good.updateMany.mock.calls.map(c => c[0]);
      expect(written).toEqual([
        { where: { id: 'g-brand', orgId: ORG, deletedAt: null }, data: { salePrice: 140 } },
      ]);
      const history = prisma.priceHistory.createMany.mock.calls.flatMap(
        c => (c[0] as { data: Array<{ goodId: string; pricingRuleId: string }> }).data,
      );
      expect(history.map(h => [h.goodId, h.pricingRuleId])).toEqual([['g-brand', 'brand']]);
    });
  });

  // guards: BR-GOOD-011
  describe('прийом партії', () => {
    const receipt = { goodId: 'g1', warehouseId: 'wh1', stockMovementId: 'm1', receivedQty: 2 };

    it('без правила: ціна товару та сама, історії немає, партія — з поточною ціною товару', async () => {
      prisma = fakePrisma(
        [rule({ id: 'brand', brandId: 'b1' })],
        [goodRow('g1', { salePrice: 125 })],
      );
      const { batch } = await build(prisma);

      await batch.createFromReceipt(ORG, { ...receipt, costPrice: 100 });

      expect(prisma.good.update).not.toHaveBeenCalled();
      expect(prisma.priceHistory.create).not.toHaveBeenCalled();
      expect(prisma.stockBatch.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ salePrice: 125 }) }),
      );
    });

    // Новий товар без ціни: правила немає → ціна лишається 0 (раніше ставала собівартістю).
    it('новий товар без ціни й без правила лишається з ціною 0 — собівартість не підставляється', async () => {
      prisma = fakePrisma([], [goodRow('g1', { salePrice: 0 })]);
      const { batch } = await build(prisma);

      await batch.createFromReceipt(ORG, { ...receipt, costPrice: 100 });

      expect(prisma.good.update).not.toHaveBeenCalled();
      expect(prisma.priceHistory.create).not.toHaveBeenCalled();
      expect(prisma.stockBatch.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ salePrice: 0 }) }),
      );
    });

    it('з правилом — ціна за правилом і запис в історії, як і раніше', async () => {
      prisma = fakePrisma([rule({ id: 'all', percentValue: 40 })], [goodRow('g1')]);
      const { batch } = await build(prisma);

      await batch.createFromReceipt(ORG, { ...receipt, costPrice: 100 });

      expect(prisma.good.update).toHaveBeenCalledWith({
        where: { id: 'g1', orgId: ORG },
        data: { salePrice: 140 },
      });
      expect(prisma.priceHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ oldPrice: 125, newPrice: 140 }),
        }),
      );
    });
  });
});
