import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ReportsService } from './reports.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { matchesWhere } from '../calendar/calendar.spec-fixture';

/**
 * BR-RPT-032 — «Звіт по складу»: товар, видалений з каталогу, але із залишком, лишається у звіті й
 * підсумках з позначкою `goodDeleted` (картки в нього немає — web не робить рядок посиланням).
 *
 * Сховище залишків ВИКОНУЄ `where` (`matchesWhere`) і віддає товар лише з тими полями, що названі
 * в `include.good.select`: так тест бачить і фільтр, і те, що `deletedAt` справді вибирається.
 *
 * Mutation-verify (2026-10-29): додати `good: { deletedAt: null }` у відбір залишків → падає
 * «видалений товар лишається»; прибрати `deletedAt: true` з вибірки товару → падає «живий товар
 * без позначки» (`undefined !== null` позначило б усі товари видаленими).
 *
 * BR-RPT-034 — дві вартості залишку: `costValue` — Σ remainingQty × costPrice активних партій
 * товару на ЦЬОМУ складі, кількість поза партіями — за `purchasePrice`; `saleValue` — кількість ×
 * `salePrice`. Агрегат партій — сирий SQL; фейк будує з шаблону справжній `Prisma.sql` і застосовує
 * до партій лише ті умови, що є в його тексті (orgId і склад — з параметрів), тож прибрана з SQL
 * умова пропускає «зайву» партію в суму.
 * Mutation-verify (2026-10-29): прибрати `"isActive" = true` → падає «неактивна партія»; прибрати
 * `"remainingQty" > 0` → падає «вичерпана партія»; групувати лише за товаром → падає «інший
 * склад»; `outside = 0` → падає «поза партіями»; `saleValue` від `purchasePrice` → падає «ціна
 * продажу»; прибрати `purchasePrice: true` з вибірки → падає «поза партіями».
 */

type Row = Record<string, unknown>;
const ORG = 'org-1';

const good = (id: string, deletedAt: Date | null, purchasePrice: number | null = 40): Row => ({
  id,
  name: `Товар ${id}`,
  sku: `SKU-${id}`,
  unit: 'шт',
  salePrice: 100,
  purchasePrice,
  deletedAt,
});

const STOCK: Row[] = [
  {
    orgId: ORG,
    goodId: 'live',
    warehouseId: 'wh',
    quantity: 2,
    reserved: 0,
    deletedAt: null,
    good: good('live', null),
    warehouse: { name: 'Основний' },
  },
  {
    orgId: ORG,
    goodId: 'gone',
    warehouseId: 'wh',
    quantity: 3,
    reserved: 1,
    deletedAt: null,
    good: good('gone', new Date('2026-10-01T10:00:00Z')),
    warehouse: { name: 'Основний' },
  },
  {
    orgId: 'org-2',
    goodId: 'alien',
    warehouseId: 'wh',
    quantity: 9,
    reserved: 0,
    deletedAt: null,
    good: good('alien', null),
    warehouse: { name: 'Чужий' },
  },
];

/** Проєкція вкладеного `select` — товар повертається лише з названими полями. */
function project(row: Row, select: Record<string, boolean> | undefined): Row {
  if (!select) return row;
  return Object.fromEntries(Object.keys(select).map(k => [k, row[k]]));
}

interface Batch {
  orgId: string;
  goodId: string;
  warehouseId: string;
  remainingQty: number;
  costPrice: number;
  isActive: boolean;
}

/**
 * `$queryRaw` агрегату партій: збирає справжній `Prisma.sql` (вкладений фрагмент складу
 * розгортається в `$N`) і застосовує лише ті умови, що є в тексті запиту.
 */
function runBatchQuery(batches: Batch[], strings: TemplateStringsArray, values: unknown[]) {
  const q = Prisma.sql(strings, ...values);
  const sql = q.text;
  const params = q.values;
  const param = (re: RegExp): unknown => {
    const m = re.exec(sql);
    return m ? params[Number(m[1]) - 1] : undefined;
  };
  const org = param(/"orgId" = \$(\d+)/);
  const wh = param(/"warehouseId" = \$(\d+)/);
  const byGoodAndWarehouse = /GROUP BY "goodId", "warehouseId"/.test(sql);
  const groups = new Map<
    string,
    { goodId: string; warehouseId: string; qty: number; cost: number }
  >();
  for (const b of batches) {
    if (b.orgId !== org) continue;
    if (sql.includes('"isActive" = true') && !b.isActive) continue;
    if (sql.includes('"remainingQty" > 0') && !(b.remainingQty > 0)) continue;
    if (wh !== undefined && b.warehouseId !== wh) continue;
    const key = byGoodAndWarehouse ? `${b.goodId}::${b.warehouseId}` : b.goodId;
    const g = groups.get(key) ?? { goodId: b.goodId, warehouseId: b.warehouseId, qty: 0, cost: 0 };
    g.qty += b.remainingQty;
    g.cost += b.remainingQty * b.costPrice;
    groups.set(key, g);
  }
  return Promise.resolve([...groups.values()]);
}

describe('ReportsService.stock — видалені товари (BR-RPT-032) і вартості (BR-RPT-034)', () => {
  let service: ReportsService;
  let stock: Row[];
  let batches: Batch[];

  beforeEach(async () => {
    stock = STOCK;
    batches = [];
    const prisma = {
      $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
        runBatchQuery(batches, strings, values),
      ),
      warehouse: { findFirst: vi.fn().mockResolvedValue({ id: 'wh' }) },
      stockItem: {
        findMany: vi.fn(
          ({
            where,
            include,
          }: {
            where: Row;
            include: { good: { select: Record<string, boolean> } };
          }) =>
            Promise.resolve(
              stock
                .filter(r => matchesWhere(r, where))
                .map(r => ({
                  ...r,
                  good: project(r.good as Row, include.good.select),
                })),
            ),
        ),
      },
      stockMovement: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const module = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettingsService, useValue: { getOrganisationSettings: vi.fn() } },
      ],
    }).compile();
    service = module.get(ReportsService);
  });

  // guards: BR-RPT-032
  it('видалений товар із залишком лишається у звіті й підсумках вартості, з позначкою', async () => {
    const r = await service.stock(ORG);
    expect(r.stockItems.map(i => [i.goodId, i.goodDeleted])).toEqual([
      ['live', false],
      ['gone', true],
    ]);
    // Партій немає — собівартість за purchasePrice (40), продаж — за salePrice (100).
    expect(r.stockItems.find(i => i.goodId === 'gone')).toMatchObject({
      quantity: 3,
      available: 2,
      saleValue: 300,
      costValue: 120,
    });
    expect(r.totalSaleValue).toBe(500);
    expect(r.totalCostValue).toBe(200);
  });

  // guards: BR-RPT-032
  it('живий товар — без позначки; поле є в кожному рядку (boolean, не undefined)', async () => {
    const r = await service.stock(ORG, 'wh');
    for (const i of r.stockItems) expect(typeof i.goodDeleted).toBe('boolean');
    expect(r.stockItems.find(i => i.goodId === 'live')?.goodDeleted).toBe(false);
  });

  describe('дві вартості залишку (BR-RPT-034)', () => {
    const item = (goodId: string, warehouseId: string, quantity: number, g: Row = {}): Row => ({
      orgId: ORG,
      goodId,
      warehouseId,
      quantity,
      reserved: 0,
      deletedAt: null,
      good: { ...good(goodId, null), ...g },
      warehouse: { name: warehouseId },
    });
    const batch = (over: Partial<Batch>): Batch => ({
      orgId: ORG,
      goodId: 'g',
      warehouseId: 'wh',
      remainingQty: 1,
      costPrice: 50,
      isActive: true,
      ...over,
    });

    // guards: BR-RPT-034
    it('собівартість — з партій (2 × 50 + 1 × 60), ціна продажу — кількість × salePrice', async () => {
      stock = [item('g', 'wh', 3)];
      batches = [
        batch({ remainingQty: 2, costPrice: 50 }),
        batch({ remainingQty: 1, costPrice: 60 }),
      ];
      const r = await service.stock(ORG);
      expect(r.stockItems[0]).toMatchObject({ costValue: 160, saleValue: 300 });
      expect(r).toMatchObject({ totalCostValue: 160, totalSaleValue: 300 });
    });

    // guards: BR-RPT-034
    it('кількість поза партіями — за purchasePrice товару (3 з партій + 2 × 40)', async () => {
      stock = [item('g', 'wh', 5)];
      batches = [
        batch({ remainingQty: 2, costPrice: 50 }),
        batch({ remainingQty: 1, costPrice: 60 }),
      ];
      const r = await service.stock(ORG);
      expect(r.stockItems[0]?.costValue).toBe(240);
    });

    // guards: BR-RPT-034
    it('неактивна, вичерпана й чужа партії не входять; партія іншого складу — у свій рядок', async () => {
      stock = [item('g', 'wh', 1), item('g', 'wh2', 1)];
      batches = [
        batch({ remainingQty: 1, costPrice: 50 }),
        batch({ remainingQty: 4, costPrice: 999, isActive: false }),
        batch({ remainingQty: -2, costPrice: 999 }),
        batch({ remainingQty: 3, costPrice: 999, orgId: 'org-2' }),
        batch({ warehouseId: 'wh2', remainingQty: 1, costPrice: 70 }),
      ];
      const r = await service.stock(ORG);
      expect(r.stockItems.map(i => [i.warehouseName, i.costValue])).toEqual([
        ['wh', 50],
        ['wh2', 70],
      ]);
    });

    // guards: BR-RPT-034
    it('зі складом — партії лише цього складу', async () => {
      stock = [item('g', 'wh', 2)];
      batches = [
        batch({ remainingQty: 1, costPrice: 50 }),
        batch({ warehouseId: 'wh2', costPrice: 70 }),
      ];
      const r = await service.stock(ORG, 'wh');
      // 1 × 50 з партії + 1 поза партіями × 40
      expect(r.stockItems[0]?.costValue).toBe(90);
    });

    // guards: BR-RPT-034
    it('без партій і без закупівельної ціни — собівартість 0, ціна продажу лишається', async () => {
      stock = [item('g', 'wh', 2, { purchasePrice: null })];
      const r = await service.stock(ORG);
      expect(r.stockItems[0]).toMatchObject({ costValue: 0, saleValue: 200 });
    });
  });
});
