import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { aggregate } from './report-aggregator';
import { getEntity } from './report-registry';

const woPart = getEntity('workOrderPart');
const wo = getEntity('workOrder');

// Хелпер: рядки WorkOrderPart з relation good.name (як після include).
const part = (
  over: Partial<{ quantity: number; amount: number; goodName: string; cp: string }>,
) => ({
  quantity: over.quantity ?? 1,
  amount: over.amount ?? 0,
  good: { name: over.goodName ?? 'Товар' },
  workOrder: { counterparty: { companyName: over.cp ?? 'Клієнт А', type: 'CLIENT' } },
});

describe('report-aggregator', () => {
  it('SUM/AVG/MIN/MAX коректність без групування; count через rowCount', () => {
    const rows = [part({ amount: 100 }), part({ amount: 200 }), part({ amount: 300 })];
    const r = aggregate(
      rows,
      {
        groupBy: [],
        aggregations: [
          { field: 'amount', agg: 'SUM' },
          { field: 'amount', agg: 'AVG' },
          { field: 'amount', agg: 'MIN' },
          { field: 'amount', agg: 'MAX' },
        ],
      },
      woPart,
    );
    expect(r.grandTotals.SUM_amount).toBe(600);
    expect(r.grandTotals.AVG_amount).toBe(200);
    expect(r.grandTotals.MIN_amount).toBe(100);
    expect(r.grandTotals.MAX_amount).toBe(300);
    // COUNT більше не пропонується per-field — кількість записів через rowCount (та group.count).
    expect(r.rowCount).toBe(3);
    expect(r.detailRows).toEqual([]); // includeRows не заданий → детальних немає
  });

  it('includeRows без групування → плоскі детальні рядки (проєкція columns)', () => {
    const rows = [
      part({ amount: 100, goodName: 'Гальма' }),
      part({ amount: 200, goodName: 'Масло' }),
    ];
    const r = aggregate(
      rows,
      { groupBy: [], columns: ['amount', 'good.name'], includeRows: true },
      woPart,
    );
    expect(r.tree).toEqual([]);
    expect(r.detailRows).toEqual([
      { amount: 100, 'good.name': 'Гальма' },
      { amount: 200, 'good.name': 'Масло' },
    ]);
  });

  it('includeRows з групуванням → детальні рядки на листі', () => {
    const rows = [
      part({ cp: 'А', goodName: 'Гальма', amount: 100 }),
      part({ cp: 'А', goodName: 'Масло', amount: 50 }),
    ];
    const r = aggregate(
      rows,
      {
        groupBy: ['workOrder.counterparty.companyName'],
        columns: ['amount'],
        includeRows: true,
      },
      woPart,
    );
    expect(r.tree[0].rows).toEqual([{ amount: 100 }, { amount: 50 }]);
  });

  it('includeRows + columns=[] → детальні рядки НЕ проєктуються (уникнення шуму)', () => {
    const rows = [part({ amount: 10 }), part({ amount: 20 })];
    // Без columns і без групування: detailRows має бути [], а не [{}, {}].
    const flat = aggregate(rows, { groupBy: [], columns: [], includeRows: true }, woPart);
    expect(flat.detailRows).toEqual([]);
    // З групуванням і без columns: node.rows не додається.
    const grouped = aggregate(
      rows,
      {
        groupBy: ['workOrder.counterparty.companyName'],
        columns: [],
        includeRows: true,
      },
      woPart,
    );
    expect(grouped.tree[0].rows).toBeUndefined();
  });

  it('групування по date-полю нормалізує ключ до дня (YYYY-MM-DD, без годин)', () => {
    // Два рухи в один день з різним часом → одна група (раніше кожна секунда окрема).
    const rows = [
      { type: 'RECEIPT', quantity: 5, createdAt: new Date('2026-09-03T08:15:30Z') },
      { type: 'RECEIPT', quantity: 3, createdAt: new Date('2026-09-03T19:42:11Z') },
      { type: 'RECEIPT', quantity: 2, createdAt: new Date('2026-09-04T10:00:00Z') },
    ];
    const sm = getEntity('stockMovement');
    const r = aggregate(
      rows,
      { groupBy: ['createdAt'], aggregations: [{ field: 'quantity', agg: 'SUM' }] },
      sm,
    );
    expect(r.tree.map(n => n.key)).toEqual(['2026-09-03', '2026-09-04']);
    expect(r.tree[0].count).toBe(2); // два рухи 03.09 в одній групі
    expect(r.tree[0].value).toBe('2026-09-03'); // value — день, не timestamp
  });

  it('sortByAggregate сортує групи за агрегатом (desc)', () => {
    const rows = [
      part({ cp: 'Малий', amount: 10 }),
      part({ cp: 'Великий', amount: 500 }),
      part({ cp: 'Середній', amount: 100 }),
    ];
    const r = aggregate(
      rows,
      {
        groupBy: ['workOrder.counterparty.companyName'],
        aggregations: [{ field: 'amount', agg: 'SUM' }],
        sortByAggregate: { alias: 'SUM_amount', dir: 'desc' },
      },
      woPart,
    );
    expect(r.tree.map(n => n.value)).toEqual(['Великий', 'Середній', 'Малий']);
  });

  it('ієрархічне групування: контрагент → товар (як у вимозі)', () => {
    const rows = [
      part({ cp: 'Клієнт А', goodName: 'Гальма', amount: 100 }),
      part({ cp: 'Клієнт А', goodName: 'Гальма', amount: 50 }),
      part({ cp: 'Клієнт А', goodName: 'Масло', amount: 200 }),
      part({ cp: 'Клієнт Б', goodName: 'Фільтр', amount: 30 }),
    ];
    const r = aggregate(
      rows,
      {
        groupBy: ['workOrder.counterparty.companyName', 'good.name'],
        aggregations: [{ field: 'amount', agg: 'SUM' }],
      },
      woPart,
    );
    expect(r.tree).toHaveLength(2); // 2 контрагенти
    const a = r.tree.find(n => n.key === 'Клієнт А')!;
    expect(a.aggregates.SUM_amount).toBe(350);
    expect(a.children).toHaveLength(2); // Гальма, Масло
    const brakes = a.children.find(c => c.key === 'Гальма')!;
    expect(brakes.aggregates.SUM_amount).toBe(150);
    expect(brakes.count).toBe(2);
  });

  it('grandTotals — незалежний прохід (== Σ листків для SUM)', () => {
    const rows = [part({ cp: 'А', amount: 100 }), part({ cp: 'Б', amount: 250 })];
    const r = aggregate(
      rows,
      {
        groupBy: ['workOrder.counterparty.companyName'],
        aggregations: [{ field: 'amount', agg: 'SUM' }],
      },
      woPart,
    );
    const sumOfLeaves = r.tree.reduce((s, n) => s + (n.aggregates.SUM_amount as number), 0);
    expect(r.grandTotals.SUM_amount).toBe(sumOfLeaves);
    expect(r.grandTotals.SUM_amount).toBe(350);
  });

  it('недозволена агрегація для поля → BadRequestException', () => {
    // price у workOrderPart має лише AVG/MIN/MAX (не SUM)
    expect(() =>
      aggregate(
        [part({})],
        { groupBy: [], aggregations: [{ field: 'price', agg: 'SUM' }] },
        woPart,
      ),
    ).toThrow(BadRequestException);
  });

  it('AVG/MIN/MAX над порожньою вибіркою → null', () => {
    const r = aggregate(
      [],
      {
        groupBy: [],
        aggregations: [
          { field: 'amount', agg: 'AVG' },
          { field: 'amount', agg: 'SUM' },
        ],
      },
      woPart,
    );
    expect(r.grandTotals.AVG_amount).toBeNull();
    expect(r.grandTotals.SUM_amount).toBe(0); // SUM порожнього = 0
    expect(r.rowCount).toBe(0);
    expect(r.tree).toHaveLength(0);
  });

  it('null-значення групування → окрема група "∅" у кінці', () => {
    const rows = [
      { amount: 10, good: { name: 'X' } },
      { amount: 20, good: { name: null } },
    ];
    const r = aggregate(
      rows,
      { groupBy: ['good.name'], aggregations: [{ field: 'amount', agg: 'SUM' }] },
      woPart,
    );
    expect(r.tree.map(n => n.key)).toEqual(['X', '∅']);
  });

  it('5-рівневе групування не падає (WorkOrder має ≥5 groupable)', () => {
    const rows = [
      {
        status: 'COMPLETED',
        priority: 'HIGH',
        number: 'WO-1',
        counterparty: { type: 'CLIENT', companyName: 'А' },
        branch: { name: 'Філія 1' },
        totalAmount: 500,
      },
    ];
    const r = aggregate(
      rows,
      {
        groupBy: [
          'status',
          'priority',
          'counterparty.type',
          'counterparty.companyName',
          'branch.name',
        ],
        aggregations: [{ field: 'totalAmount', agg: 'SUM' }],
      },
      wo,
    );
    // 1 рядок → ланцюг з 5 вкладених вузлів
    let node = r.tree[0];
    let depth = 1;
    while (node.children.length > 0) {
      node = node.children[0];
      depth++;
    }
    expect(depth).toBe(5);
    expect(node.aggregates.SUM_totalAmount).toBe(500);
  });

  // ── Bug #619: signedByType — RESERVATION/RESERVATION_RELEASE виключені з нетто ──
  it('Bug #619: signedByType SUM(quantity) виключає RESERVATION/RESERVATION_RELEASE', () => {
    const sm = getEntity('stockMovement');
    // raw stored values (як у БД): RECEIPT >0, WRITEOFF <0, RESERVATION >0,
    // RESERVATION_RELEASE <0 (per inventory.service.ts:78,127,143).
    const rows = [
      { type: 'RECEIPT', quantity: 10 },
      { type: 'RECEIPT', quantity: 5 },
      { type: 'WRITEOFF', quantity: -3 },
      { type: 'WRITEOFF', quantity: -2 },
      { type: 'RESERVATION', quantity: 4 }, // не фізичне → у нетто не входить
      { type: 'RESERVATION_RELEASE', quantity: -4 }, // не фізичне → у нетто не входить
    ];
    const r = aggregate(
      rows,
      { groupBy: [], aggregations: [{ field: 'quantity', agg: 'SUM' }] },
      sm,
    );
    // Фізичне нетто: RECEIPT(+15) + WRITEOFF(-5) = +10.
    // Якби RESERVATION/RESERVATION_RELEASE потрапляли — було б інше.
    expect(r.grandTotals.SUM_quantity).toBe(10);
  });

  it('Bug #619: WRITEOFF з випадково додатним raw теж стає негативним (backstop)', () => {
    const sm = getEntity('stockMovement');
    const rows = [
      { type: 'RECEIPT', quantity: 10 },
      { type: 'WRITEOFF', quantity: 3 }, // помилково додатний raw — має стати -3
    ];
    const r = aggregate(
      rows,
      { groupBy: [], aggregations: [{ field: 'quantity', agg: 'SUM' }] },
      sm,
    );
    expect(r.grandTotals.SUM_quantity).toBe(7);
  });

  it('Bug #619: групування по type — RESERVATION/RESERVATION_RELEASE бакети мають SUM=0', () => {
    const sm = getEntity('stockMovement');
    const rows = [
      { type: 'RECEIPT', quantity: 10 },
      { type: 'RESERVATION', quantity: 5 },
      { type: 'RESERVATION', quantity: 3 },
      { type: 'RESERVATION_RELEASE', quantity: -5 },
    ];
    const r = aggregate(
      rows,
      { groupBy: ['type'], aggregations: [{ field: 'quantity', agg: 'SUM' }] },
      sm,
    );
    const buckets = Object.fromEntries(r.tree.map(n => [n.key, n.aggregates.SUM_quantity]));
    expect(buckets.RECEIPT).toBe(10);
    expect(buckets.RESERVATION).toBe(0); // всі значення null → sum=0
    expect(buckets.RESERVATION_RELEASE).toBe(0);
    expect(r.grandTotals.SUM_quantity).toBe(10);
  });
});
