import { Test } from '@nestjs/testing';
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
 */

type Row = Record<string, unknown>;
const ORG = 'org-1';

const good = (id: string, deletedAt: Date | null): Row => ({
  id,
  name: `Товар ${id}`,
  sku: `SKU-${id}`,
  unit: 'шт',
  salePrice: 100,
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

describe('ReportsService.stock — видалені товари (BR-RPT-032)', () => {
  let service: ReportsService;

  beforeEach(async () => {
    const prisma = {
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
              STOCK.filter(r => matchesWhere(r, where)).map(r => ({
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
  it('видалений товар із залишком лишається у звіті й підсумку вартості, з позначкою', async () => {
    const r = await service.stock(ORG);
    expect(r.stockItems.map(i => [i.goodId, i.goodDeleted])).toEqual([
      ['live', false],
      ['gone', true],
    ]);
    expect(r.stockItems.find(i => i.goodId === 'gone')).toMatchObject({
      quantity: 3,
      available: 2,
      value: 300,
    });
    expect(r.totalValue).toBe(500);
  });

  // guards: BR-RPT-032
  it('живий товар — без позначки; поле є в кожному рядку (boolean, не undefined)', async () => {
    const r = await service.stock(ORG, 'wh');
    for (const i of r.stockItems) expect(typeof i.goodDeleted).toBe('boolean');
    expect(r.stockItems.find(i => i.goodId === 'live')?.goodDeleted).toBe(false);
  });
});
