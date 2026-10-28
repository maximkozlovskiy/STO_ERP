import { describe, it, expect } from 'vitest';
import {
  allocatePayrollByMonth,
  buildCategoryRows,
  monthsBetween,
  sumRootRows,
  type PnlPayrollPeriod,
} from './pnl.calc';

/**
 * BR-RPT-030 — чисті функції звіту P&L: місяці періоду, розподіл зарплати за днями, дерево статей.
 *
 * Mutation-verify (2026-10-29): прибрати фільтр статусу в allocatePayrollByMonth → падає «DRAFT і
 * CANCELLED»; прибрати перевірку deletedAt → падає «видалений період»; ділити на місяці порівну
 * замість днів → падає «через межу місяців»; не обрізати відрізок межами from..to → падає
 * «частковий місяць звіту».
 */

const d = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const period = (
  over: Partial<PnlPayrollPeriod> & { from: string; to: string },
): PnlPayrollPeriod => ({
  periodStart: d(over.from),
  periodEnd: d(over.to),
  status: over.status ?? 'COMPUTED',
  deletedAt: over.deletedAt ?? null,
  accrued: over.accrued ?? 0,
});

describe('monthsBetween', () => {
  it('місяці від from до to включно, через межу року', () => {
    expect(monthsBetween('2025-11-15', '2026-02-03')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });

  it('один день — один місяць', () => {
    expect(monthsBetween('2026-10-29', '2026-10-29')).toEqual(['2026-10']);
  });
});

describe('allocatePayrollByMonth — BR-RPT-030 п. 4', () => {
  const today = '2026-12-31';

  // guards: BR-RPT-030
  it('період в одному місяці — уся сума в цей місяць', () => {
    const r = allocatePayrollByMonth(
      [period({ from: '2026-09-01', to: '2026-09-30', accrued: 12_000 })],
      ['2026-09', '2026-10'],
      '2026-09-01',
      '2026-10-31',
      today,
    );
    expect(r.amounts).toEqual([12_000, 0]);
  });

  // guards: BR-RPT-030
  it('період через межу місяців ділиться пропорційно календарним дням, копійки без втрат', () => {
    // 16.09–15.10: 15 днів вересня + 15 днів жовтня = 30 днів → порівну.
    const half = allocatePayrollByMonth(
      [period({ from: '2026-09-16', to: '2026-10-15', accrued: 1000 })],
      ['2026-09', '2026-10'],
      '2026-09-01',
      '2026-10-31',
      today,
    );
    expect(half.amounts).toEqual([500, 500]);

    // 29.09–08.10: 2 дні вересня і 8 днів жовтня з 10 → 20% / 80%.
    const skew = allocatePayrollByMonth(
      [period({ from: '2026-09-29', to: '2026-10-08', accrued: 100.01 })],
      ['2026-09', '2026-10'],
      '2026-09-01',
      '2026-10-31',
      today,
    );
    expect(skew.amounts[0]).toBe(20);
    expect(skew.amounts[1]).toBe(80.01);
    expect(Math.round(((skew.amounts[0] ?? 0) + (skew.amounts[1] ?? 0)) * 100)).toBe(10_001);
  });

  // guards: BR-RPT-030
  it('частковий місяць звіту — лише дні в межах from..to', () => {
    // Період 01–30.09 (30 днів), звіт з 16.09 → 15 днів = половина.
    const r = allocatePayrollByMonth(
      [period({ from: '2026-09-01', to: '2026-09-30', accrued: 3000 })],
      ['2026-09'],
      '2026-09-16',
      '2026-09-30',
      today,
    );
    expect(r.amounts).toEqual([1500]);
  });

  // guards: BR-RPT-030
  it('DRAFT і CANCELLED не враховуються; COMPUTED і PAID — так', () => {
    const r = allocatePayrollByMonth(
      [
        period({ from: '2026-09-01', to: '2026-09-30', accrued: 100, status: 'DRAFT' }),
        period({ from: '2026-09-01', to: '2026-09-30', accrued: 200, status: 'CANCELLED' }),
        period({ from: '2026-09-01', to: '2026-09-30', accrued: 300, status: 'COMPUTED' }),
        period({ from: '2026-09-01', to: '2026-09-30', accrued: 400, status: 'PAID' }),
      ],
      ['2026-09'],
      '2026-09-01',
      '2026-09-30',
      today,
    );
    expect(r.amounts).toEqual([700]);
  });

  // guards: BR-RPT-030
  it('видалений період не враховується і місяць не покриває', () => {
    const r = allocatePayrollByMonth(
      [period({ from: '2026-09-01', to: '2026-09-30', accrued: 500, deletedAt: d('2026-10-01') })],
      ['2026-09'],
      '2026-09-01',
      '2026-09-30',
      today,
    );
    expect(r.amounts).toEqual([0]);
    expect(r.missingMonths).toEqual(['2026-09']);
  });

  // guards: BR-RPT-030
  it('місяць без урахованого періоду — у missingMonths; майбутній місяць — ні', () => {
    const r = allocatePayrollByMonth(
      [
        period({ from: '2026-08-01', to: '2026-08-31', accrued: 10 }),
        period({ from: '2026-09-01', to: '2026-09-30', accrued: 10, status: 'DRAFT' }),
      ],
      ['2026-08', '2026-09', '2026-10', '2026-11'],
      '2026-08-01',
      '2026-11-30',
      '2026-10-29',
    );
    expect(r.missingMonths).toEqual(['2026-09', '2026-10']);
  });

  it('розрахований період із нульовим нарахуванням місяць покриває', () => {
    const r = allocatePayrollByMonth(
      [period({ from: '2026-09-10', to: '2026-09-12', accrued: 0 })],
      ['2026-09'],
      '2026-09-01',
      '2026-09-30',
      today,
    );
    expect(r.missingMonths).toEqual([]);
  });
});

describe('buildCategoryRows — дерево статей BR-RPT-030 пп. 5–6', () => {
  const cats = [
    { id: 'rent', name: 'Оренда', parentId: null, sortOrder: 1 },
    { id: 'util', name: 'Комунальні', parentId: null, sortOrder: 0 },
    { id: 'power', name: 'Електрика', parentId: 'util', sortOrder: 0 },
    { id: 'water', name: 'Вода', parentId: 'util', sortOrder: 1 },
    { id: 'idle', name: 'Без руху', parentId: null, sortOrder: 2 },
  ];

  // guards: BR-RPT-030
  it('корінь — підсумок своїх і підстатей; порядок дерева; статті без сум не показуються', () => {
    const own = new Map<string | null, number[]>([
      ['power', [100, 0]],
      ['water', [0, 50.5]],
      ['util', [10, 0]],
      ['rent', [1000, 1000]],
      [null, [7, 0]],
    ]);
    const rows = buildCategoryRows(own, cats, 2);
    expect(rows.map(r => [r.categoryId, r.depth, r.amounts, r.total])).toEqual([
      ['util', 0, [110, 50.5], 160.5],
      ['power', 1, [100, 0], 100],
      ['water', 1, [0, 50.5], 50.5],
      ['rent', 0, [1000, 1000], 2000],
      [null, 0, [7, 0], 7],
    ]);
    expect(rows[1]?.parentId).toBe('util');
    // Підсумок розділу — лише корені й «без статті», підстатті вдруге не додаються.
    expect(sumRootRows(rows, 2)).toEqual([1117, 1050.5]);
  });
});
