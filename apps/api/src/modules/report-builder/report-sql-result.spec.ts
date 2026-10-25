import { describe, it, expect } from 'vitest';
import { assembleMergedRows, assembleTree } from './report-sql-result';
import { REPORT_GROUP_CAP, REPORT_MERGED_CAP } from './report-sql.builder';
import { getEntity, getField } from './report-registry';

/** Рядки SQL-агрегатів → дерево / склеєні рядки (BR-RPT-027). Чисті функції, без БД. */

const wo = getEntity('workOrder');
const status = getField(wo, 'status');
const priority = getField(wo, 'priority');
const aggs = [{ field: 'totalAmount', agg: 'SUM' as const }];

describe('report-sql-result', () => {
  // guards: BR-RPT-013
  it('ROLLUP → дерево: рівень за GROUPING, «Разом» з рядка без ключів, NULL-група — «∅»', () => {
    const rollup = [
      { k0: null, k1: null, g0: 1, g1: 1, n: 6, a0: '600' },
      { k0: 'PAID', k1: null, g0: 0, g1: 1, n: 4, a0: '400' },
      { k0: 'PAID', k1: 'HIGH', g0: 0, g1: 0, n: 3, a0: '300' },
      { k0: 'PAID', k1: null, g0: 0, g1: 0, n: 1, a0: '100' },
      { k0: null, k1: null, g0: 0, g1: 1, n: 2, a0: '200' },
      { k0: null, k1: 'LOW', g0: 0, g1: 0, n: 2, a0: '200' },
    ];
    const t = assembleTree(rollup, [status, priority], aggs, {
      detail: null,
      columns: [],
      entity: wo,
    });
    expect(t.rowCount).toBe(6);
    expect(t.grandTotals).toEqual({ SUM_totalAmount: 600 });
    expect(t.tree.map(n => [n.key, n.count])).toEqual([
      ['PAID', 4],
      ['∅', 2], // порожня група — у кінці
    ]);
    expect(t.tree[0].children.map(n => [n.key, n.aggregates.SUM_totalAmount])).toEqual([
      ['HIGH', 300],
      ['∅', 100],
    ]);
    expect(t.tree[1].value).toBeNull();
    expect(t.groupsTruncated).toBe(false);
  });

  // guards: BR-RPT-013
  it('сортування груп за агрегатом; AVG над порожнім — null, а не 0', () => {
    const rollup = [
      { k0: null, g0: 1, n: 3, a0: '30' },
      { k0: 'A', g0: 0, n: 1, a0: '5' },
      { k0: 'B', g0: 0, n: 2, a0: '25' },
    ];
    const t = assembleTree(rollup, [status], aggs, {
      detail: null,
      columns: [],
      entity: wo,
      sortByAggregate: { alias: 'SUM_totalAmount', dir: 'desc' },
    });
    expect(t.tree.map(n => n.key)).toEqual(['B', 'A']);
    const avg = assembleTree([{ n: 0, a0: null }], [], [{ field: 'totalAmount', agg: 'AVG' }], {
      detail: null,
      columns: [],
      entity: wo,
    });
    expect(avg.grandTotals).toEqual({ AVG_totalAmount: null });
    expect(avg.rowCount).toBe(0);
  });

  // guards: BR-RPT-008
  it('детальні рядки (≤5000) чіпляються до листових груп за тими самими ключами', () => {
    const rollup = [
      { k0: null, g0: 1, n: 3, a0: '0' },
      { k0: 'PAID', g0: 0, n: 2, a0: '0' },
      { k0: null, g0: 0, n: 1, a0: '0' },
    ];
    const detail = [
      { status: 'PAID', number: 'WO-1' },
      { status: 'PAID', number: 'WO-2' },
      { status: null, number: 'WO-3' },
    ];
    const t = assembleTree(rollup, [status], aggs, { detail, columns: ['number'], entity: wo });
    expect(t.tree.find(n => n.key === 'PAID')?.rows).toEqual([
      { number: 'WO-1' },
      { number: 'WO-2' },
    ]);
    expect(t.tree.find(n => n.key === '∅')?.rows).toEqual([{ number: 'WO-3' }]);
  });

  // guards: BR-RPT-008
  it('груп більше за ліміт відповіді → groupsTruncated', () => {
    const rollup = Array.from({ length: REPORT_GROUP_CAP + 1 }, (_, i) => ({
      k0: `S${i}`,
      g0: 0,
      n: 1,
      a0: '1',
    }));
    expect(
      assembleTree(rollup, [status], aggs, { detail: null, columns: [], entity: wo })
        .groupsTruncated,
    ).toBe(true);
  });

  // guards: BR-RPT-015
  it('склеєні рядки: колонки у формі детального рядка, кількість — у __mergedCount; понад ліміт — truncated', () => {
    const pol = getEntity('purchaseOrderLine');
    const cols = ['good.name', 'price', 'quantity'];
    const out = assembleMergedRows([{ d0: 'Фільтр', d1: '100', s0: '5', n: 2 }], cols, pol);
    expect(out.detailRows).toEqual([
      { 'good.name': 'Фільтр', price: '100', quantity: 5, __mergedCount: 2 },
    ]);
    expect(out.truncated).toBe(false);
    const many = Array.from({ length: REPORT_MERGED_CAP + 1 }, () => ({
      d0: 'x',
      d1: '1',
      s0: '1',
      n: 1,
    }));
    const cut = assembleMergedRows(many, cols, pol);
    expect(cut.truncated).toBe(true);
    expect(cut.detailRows).toHaveLength(REPORT_MERGED_CAP);
  });
});
