import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { GoodsService } from './goods.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { GoodStatusesService } from '../good-statuses/good-statuses.service';

/**
 * BR-WO-029: `GET /goods/stock-totals` віддає по кожному складу ще `reserved` і `available`
 * (вільна кількість `max(0, quantity − reserved)`), за якою рядок товару наряду підписує склади
 * й обирає склад сам. Наявні поля (`totalQuantity`, `quantity`) не змінюються.
 *
 * Фейкова Prisma ВИКОНУЄ `where` (orgId, goodId IN, deletedAt) і `select`: якщо сервіс забуде
 * `reserved` у `select`, рядок прийде без нього — тест це побачить, а заготовка — ні.
 */

interface StockRow {
  orgId: string;
  goodId: string;
  warehouseId: string;
  quantity: number;
  reserved: number;
  deletedAt: Date | null;
}

interface StockWhere {
  orgId: string;
  goodId: { in: string[] };
  deletedAt: null;
}

function matches(r: StockRow, where: StockWhere): boolean {
  return r.orgId === where.orgId && where.goodId.in.includes(r.goodId) && r.deletedAt === null;
}

function fakeStockItems(rows: StockRow[]) {
  return {
    findMany: vi.fn(
      (args: { where: StockWhere; select: Record<string, boolean>; take?: number }) => {
        const hit = rows.filter(r => matches(r, args.where)).slice(0, args.take ?? rows.length);
        return Promise.resolve(
          hit.map(r =>
            Object.fromEntries(
              Object.entries(args.select)
                .filter(([, on]) => on)
                .map(([k]) => [k, r[k as keyof StockRow]]),
            ),
          ),
        );
      },
    ),
    groupBy: vi.fn((args: { where: StockWhere }) => {
      const sums = new Map<string, number>();
      for (const r of rows.filter(x => matches(x, args.where))) {
        sums.set(r.goodId, (sums.get(r.goodId) ?? 0) + r.quantity);
      }
      return Promise.resolve(
        [...sums].map(([goodId, quantity]) => ({ goodId, _sum: { quantity } })),
      );
    }),
  };
}

const row = (p: Partial<StockRow> & Pick<StockRow, 'goodId' | 'warehouseId'>): StockRow => ({
  orgId: 'org-1',
  quantity: 0,
  reserved: 0,
  deletedAt: null,
  ...p,
});

async function serviceWith(rows: StockRow[]) {
  const module = await Test.createTestingModule({
    providers: [
      GoodsService,
      { provide: PrismaService, useValue: { stockItem: fakeStockItems(rows) } },
      { provide: DocumentNumberService, useValue: { next: vi.fn() } },
      { provide: GoodStatusesService, useValue: { invalidateCache: vi.fn() } },
    ],
  }).compile();
  return module.get(GoodsService);
}

describe('GoodsService.stockTotals — вільна кількість по складах (BR-WO-029)', () => {
  let rows: StockRow[];

  beforeEach(() => {
    rows = [
      row({ goodId: 'g1', warehouseId: 'wh-main', quantity: 10, reserved: 4 }),
      row({ goodId: 'g1', warehouseId: 'wh-2', quantity: 3, reserved: 0 }),
      // Резерв понад наявність (наряд зарезервував, потім частину списали іншим документом).
      row({ goodId: 'g2', warehouseId: 'wh-main', quantity: 2, reserved: 5 }),
      // Чуже й видалене не входить ні в суму, ні в розбивку.
      row({ goodId: 'g1', warehouseId: 'wh-x', quantity: 99, reserved: 0, orgId: 'org-2' }),
      row({ goodId: 'g1', warehouseId: 'wh-del', quantity: 7, deletedAt: new Date() }),
    ];
  });

  // guards: BR-WO-029
  it('по кожному складу — quantity, reserved і available = quantity − reserved', async () => {
    const service = await serviceWith(rows);
    const res = await service.stockTotals('org-1', ['g1']);
    expect(res).toEqual([
      {
        goodId: 'g1',
        totalQuantity: 13,
        byWarehouse: [
          { warehouseId: 'wh-main', quantity: 10, reserved: 4, available: 6 },
          { warehouseId: 'wh-2', quantity: 3, reserved: 0, available: 3 },
        ],
      },
    ]);
  });

  // guards: BR-WO-029
  it('резерв понад наявність → available 0, не від’ємне; quantity і reserved — як у базі', async () => {
    const service = await serviceWith(rows);
    const [g2] = await service.stockTotals('org-1', ['g2']);
    expect(g2!.byWarehouse).toEqual([
      { warehouseId: 'wh-main', quantity: 2, reserved: 5, available: 0 },
    ]);
  });

  it('totalQuantity лишається сумою фізичної наявності (колонка «На складі»), без резерву', async () => {
    const service = await serviceWith(rows);
    const res = await service.stockTotals('org-1', ['g1', 'g2']);
    expect(res.map(r => [r.goodId, r.totalQuantity])).toEqual([
      ['g1', 13],
      ['g2', 2],
    ]);
  });
});
