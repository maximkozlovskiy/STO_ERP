import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ReportsService } from './reports.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Bug #629: похідні грошові значення у звітах квантуються до копійки (roundMoney).
 *
 * Раніше `totalCostLabor = totalLabor × LABOR_COST_RATIO(0.4)` (множення на дріб)
 * давало float-дрейф (3520.30 × 0.4 = 1408.1200000000001; 999.99 × 0.4 = 399.99600000000004),
 * який просочувався сирим у JSON звіту «Рентабельність» та CSV-експорт (reports/page.tsx).
 * Так само Σ квантованих рядків у JS-float дрейфує (revenue.totalRevenue,
 * workOrders.totalAmount, settlements.totalDebit/Credit), а різниця сум — vat.net.
 *
 * Регресія-guard: КОЖНЕ грошове поле, що повертається зі звіту, має мати ≤2 знаки після коми.
 */
const has2Decimals = (n: number): boolean => Number.isFinite(n) && Math.round(n * 100) / 100 === n;

describe('ReportsService — Bug #629 квантування грошей у звітах', () => {
  let service: ReportsService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  const orgId = 'org-1';
  const from = '2026-01-01';
  const to = '2026-12-31';

  beforeEach(async () => {
    prisma = {
      garageBranch: { findFirst: vi.fn() },
      counterparty: { findFirst: vi.fn() },
      employee: { findFirst: vi.fn() },
      warehouse: { findFirst: vi.fn() },
      invoice: { aggregate: vi.fn() },
      purchaseOrder: { aggregate: vi.fn() },
      settlementAccount: { findMany: vi.fn() },
      $queryRaw: vi.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [ReportsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ReportsService);
  });

  it('profitability: totalCostLabor/totalCost/grossProfit квантовані (drift від ×0.4 усунено)', async () => {
    // totalLabor = 3520.30 → 3520.30 × 0.4 = 1408.1200000000001 (сирий float-дрейф)
    prisma.$queryRaw
      .mockResolvedValueOnce([{ totalRevenue: 5020.3, totalLabor: 3520.3, ordersCount: 7n }])
      .mockResolvedValueOnce([{ costParts: 100.1, unknownCount: 0n }]);

    const r = await service.profitability(orgId, from, to);

    // Без roundMoney: totalCostLabor === 1408.1200000000001 → цей assert падав би.
    expect(r.totalCostLabor).toBe(1408.12);
    expect(has2Decimals(r.totalCostLabor)).toBe(true);
    expect(has2Decimals(r.totalCost)).toBe(true);
    expect(has2Decimals(r.grossProfit)).toBe(true);
    expect(has2Decimals(r.totalRevenue)).toBe(true);
    expect(has2Decimals(r.totalCostParts)).toBe(true);
    // Внутрішня узгодженість: grossProfit == totalRevenue − totalCost (до копійки).
    expect(r.grossProfit).toBe(Math.round((r.totalRevenue - r.totalCost) * 100) / 100);
  });

  it('profitability: 999.99 × 0.4 = 399.99600000000004 → 400.00 (half-away) квантовано', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ totalRevenue: 1000, totalLabor: 999.99, ordersCount: 1n }])
      .mockResolvedValueOnce([{ costParts: 0, unknownCount: 0n }]);

    const r = await service.profitability(orgId, from, to);

    expect(r.totalCostLabor).toBe(400.0);
    expect(has2Decimals(r.totalCost)).toBe(true);
    expect(has2Decimals(r.grossProfit)).toBe(true);
  });

  it('revenue: totalRevenue = Σ рядків квантовано (JS-float Σ не дрейфує)', async () => {
    // 3 дні з дробовими копійками, сума яких у JS дрейфує без roundMoney.
    prisma.garageBranch.findFirst.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValueOnce([
      { date: new Date('2026-01-01T00:00:00Z'), revenue: 0.1, labor: 0, parts: 0, count: 1n },
      { date: new Date('2026-01-02T00:00:00Z'), revenue: 0.2, labor: 0, parts: 0, count: 1n },
      { date: new Date('2026-01-03T00:00:00Z'), revenue: 33.33, labor: 0, parts: 0, count: 1n },
    ]);

    const r = await service.revenue(orgId, from, to);
    // 0.1 + 0.2 + 33.33 = 33.629999999999995 без roundMoney → assert падав би.
    expect(r.totalRevenue).toBe(33.63);
    expect(has2Decimals(r.totalRevenue)).toBe(true);
  });

  it('vatReport: net = invoiced − purchases квантовано', async () => {
    prisma.invoice.aggregate.mockResolvedValueOnce({ _sum: { totalVat: 100.1 } });
    prisma.purchaseOrder.aggregate.mockResolvedValueOnce({ _sum: { totalVat: 33.33 } });

    const r = await service.vatReport(orgId, from, to);
    // 100.10 − 33.33 = 66.77000000000001 без roundMoney → assert падав би.
    expect(r.net).toBe(66.77);
    expect(has2Decimals(r.net)).toBe(true);
    expect(has2Decimals(r.invoiced)).toBe(true);
    expect(has2Decimals(r.purchases)).toBe(true);
  });

  it('settlements: totalDebit/totalCredit = Σ балансів квантовано', async () => {
    prisma.counterparty.findFirst.mockResolvedValue(null);
    prisma.settlementAccount.findMany.mockResolvedValueOnce([
      {
        balance: 0.1,
        counterparty: { firstName: 'A', lastName: 'B', companyName: null, type: 'INDIVIDUAL' },
      },
      {
        balance: 0.2,
        counterparty: { firstName: 'C', lastName: 'D', companyName: null, type: 'INDIVIDUAL' },
      },
      {
        balance: -0.1,
        counterparty: { firstName: 'E', lastName: 'F', companyName: null, type: 'INDIVIDUAL' },
      },
      {
        balance: -0.2,
        counterparty: { firstName: 'G', lastName: 'H', companyName: null, type: 'INDIVIDUAL' },
      },
    ]);

    const r = await service.settlements(orgId);
    // 0.1 + 0.2 = 0.30000000000000004; 0.1 + 0.2 = 0.30000000000000004 (credit) без roundMoney.
    expect(r.totalDebit).toBe(0.3);
    expect(r.totalCredit).toBe(0.3);
    expect(has2Decimals(r.totalDebit)).toBe(true);
    expect(has2Decimals(r.totalCredit)).toBe(true);
  });
});
