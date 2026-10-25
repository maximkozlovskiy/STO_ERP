import { describe, it, expect } from 'vitest';
import { assembleMergedRows, assembleTree } from './report-sql-result';
import { REPORT_GROUP_CAP, REPORT_MERGED_CAP } from './report-sql.builder';
import { getEntity, getField } from './report-registry';

/** Базова валюта тестової організації (у застосунку — з OrganisationSettings). */
const BASE = 'UAH';

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
      baseCurrency: BASE,
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
      baseCurrency: BASE,
      sortByAggregate: { alias: 'SUM_totalAmount', dir: 'desc' },
    });
    expect(t.tree.map(n => n.key)).toEqual(['B', 'A']);
    const avg = assembleTree([{ n: 0, a0: null }], [], [{ field: 'totalAmount', agg: 'AVG' }], {
      detail: null,
      columns: [],
      entity: wo,
      baseCurrency: BASE,
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
    const t = assembleTree(rollup, [status], aggs, {
      detail,
      columns: ['number'],
      entity: wo,
      baseCurrency: BASE,
    });
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
      assembleTree(rollup, [status], aggs, {
        detail: null,
        columns: [],
        entity: wo,
        baseCurrency: BASE,
      }).groupsTruncated,
    ).toBe(true);
  });

  // guards: BR-RPT-015
  it('склеєні рядки: колонки у формі детального рядка, кількість — у __mergedCount; понад ліміт — truncated', () => {
    const pol = getEntity('purchaseOrderLine');
    const cols = ['good.name', 'price', 'quantity'];
    const out = assembleMergedRows(
      [{ d0: 'Фільтр', d1: '100', s0: '5', c0: 'USD', n: 2 }],
      cols,
      pol,
    );
    expect(out.detailRows).toEqual([
      { 'good.name': 'Фільтр', price: '100', quantity: 5, __currency: 'USD', __mergedCount: 2 },
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

  // Мутація: не обнуляти aggregates при кількох валютах (maskMixedCurrency) → «Разом» складає
  // гривні з доларами.
  // guards: BR-RPT-029
  it('розбивка за валютами: byCurrency у групах і «Разом»; кілька валют — спільне значення null', () => {
    const pay = getEntity('payment');
    const st = getField(pay, 'method');
    const payAggs = [
      { field: 'amount', agg: 'SUM' as const },
      { field: 'amountBase', agg: 'SUM' as const },
    ];
    const rollup = [
      { k0: null, g0: 1, n: 3, a0: '500', a1: '4600' },
      { k0: 'PAID', g0: 0, n: 2, a0: '400', a1: '400' },
      { k0: 'NEW', g0: 0, n: 1, a0: '100', a1: '4200' },
    ];
    const split = [
      { k0: null, g0: 1, cur: 'UAH', a0: '400' },
      { k0: null, g0: 1, cur: 'USD', a0: '100' },
      { k0: 'PAID', g0: 0, cur: 'UAH', a0: '400' },
      { k0: 'NEW', g0: 0, cur: 'USD', a0: '100' },
    ];
    const t = assembleTree(rollup, [st], payAggs, {
      detail: null,
      columns: [],
      entity: pay,
      currencySplit: split,
      baseCurrency: BASE,
    });
    expect(t.grandTotalsByCurrency).toEqual({ SUM_amount: { UAH: 400, USD: 100 } });
    expect(t.grandTotals).toEqual({ SUM_amount: null, SUM_amountBase: 4600 });
    const paid = t.tree.find(n => n.key === 'PAID')!;
    expect(paid.byCurrency).toEqual({ SUM_amount: { UAH: 400 } });
    expect(paid.aggregates.SUM_amount).toBe(400);
    const fresh = t.tree.find(n => n.key === 'NEW')!;
    expect(fresh.byCurrency).toEqual({ SUM_amount: { USD: 100 } });
    // без розбивки (у звіті немає сум у валюті документа) — поля немає зовсім
    const plain = assembleTree(rollup, [st], [payAggs[1]], {
      detail: null,
      columns: [],
      entity: pay,
      currencySplit: null,
      baseCurrency: BASE,
    });
    expect(plain.grandTotalsByCurrency).toBeUndefined();
    expect(plain.tree[0].byCurrency).toBeUndefined();
  });

  const pay = getEntity('payment');
  const method = getField(pay, 'method');
  const sumAmount = [{ field: 'amount', agg: 'SUM' as const }];

  // Мутація: прибрати `mixed` у sortNodes → змішана група (null) сортується як 0 і найбільша сума
  // опиняється внизу «топу за сумою».
  // guards: BR-RPT-029
  it('сортування за сумою у валюті документа: група з кількома валютами — у кінці, а не як 0', () => {
    const rollup = [
      { k0: null, g0: 1, n: 4, a0: '1100' },
      { k0: 'cash', g0: 0, n: 2, a0: '1000' },
      { k0: 'card', g0: 0, n: 1, a0: '60' },
      { k0: 'bank', g0: 0, n: 1, a0: '40' },
    ];
    const split = [
      { k0: null, g0: 1, cur: 'UAH', a0: '1060' },
      { k0: null, g0: 1, cur: 'USD', a0: '40' },
      { k0: 'cash', g0: 0, cur: 'UAH', a0: '960' },
      { k0: 'cash', g0: 0, cur: 'USD', a0: '40' },
      { k0: 'card', g0: 0, cur: 'UAH', a0: '60' },
      { k0: 'bank', g0: 0, cur: 'UAH', a0: '40' },
    ];
    for (const dir of ['desc', 'asc'] as const) {
      const t = assembleTree(rollup, [method], sumAmount, {
        detail: null,
        columns: [],
        entity: pay,
        currencySplit: split,
        baseCurrency: BASE,
        sortByAggregate: { alias: 'SUM_amount', dir },
      });
      expect(t.tree.map(n => n.key)).toEqual(
        dir === 'desc' ? ['card', 'bank', 'cash'] : ['bank', 'card', 'cash'],
      );
    }
  });

  // Мутація: лишити aggregates групи без розбивки як є → клітинка показує суму гривень із доларами.
  // guards: BR-RPT-029
  it('група, яку відрізав ліміт розбивки, — без спільного числа (валют не знаємо)', () => {
    const rollup = [
      { k0: null, g0: 1, n: 2, a0: '1000' },
      { k0: 'cash', g0: 0, n: 2, a0: '1000' },
    ];
    const t = assembleTree(rollup, [method], sumAmount, {
      detail: null,
      columns: [],
      entity: pay,
      currencySplit: [{ k0: null, g0: 1, cur: 'UAH', a0: '1000' }],
      baseCurrency: BASE,
    });
    expect(t.tree[0].aggregates.SUM_amount).toBeNull();
    expect(t.tree[0].byCurrency).toEqual({});
  });
});
