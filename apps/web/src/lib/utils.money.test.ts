import { describe, it, expect } from 'vitest';

import {
  roundMoney,
  calcVatTotals,
  calcVatOnBase,
  splitVatTotals,
  workOrderVatSplit,
  plannedWorkOrderAmount,
  lineAmount,
} from './utils';

// Regression-guard для клієнтського грошового квантування у модалках (WO-H2 / FIN-H1).
// Дзеркалить backend apps/api/src/common/utils/math.ts + vat.ts — обидві сторони мають
// округлювати ІДЕНТИЧНО, інакше preview-сума у tfoot розходиться з бекендовим amount.

// guards: BR-WO-007
describe('calcVatTotals — три режими ПДВ організації (BR-WO-007)', () => {
  const rows = [
    { qty: 2, price: 500 },
    { qty: 1, price: 200 },
  ]; // сума рядків 1200

  it('NONE: ПДВ немає, «без ПДВ» = «разом» = сума рядків — навіть при ненульовій ставці', () => {
    expect(calcVatTotals(rows, 20, 'NONE')).toEqual({
      total: 1200,
      net: 1200,
      vat: 0,
      gross: 1200,
    });
  });

  it('EXCLUSIVE («ПДВ зверху»): без ПДВ = сума рядків, разом = сума рядків + ПДВ', () => {
    expect(calcVatTotals(rows, 20, 'EXCLUSIVE')).toEqual({
      total: 1200,
      net: 1200,
      vat: 240,
      gross: 1440,
    });
  });

  it('INCLUSIVE («ПДВ у ціні»): разом = сума рядків, без ПДВ = сума рядків − ПДВ', () => {
    expect(calcVatTotals(rows, 20, 'INCLUSIVE')).toEqual({
      total: 1200,
      net: 1000,
      vat: 200,
      gross: 1200,
    });
  });

  it('ставка 0 у режимі з ПДВ → ПДВ немає', () => {
    expect(calcVatTotals(rows, 0, 'EXCLUSIVE')).toEqual({
      total: 1200,
      net: 1200,
      vat: 0,
      gross: 1200,
    });
  });

  it('інваріант net + vat = gross тримається на «незручних» сумах в обох режимах', () => {
    for (const base of [0.01, 0.03, 7.59, 100.33, 999.99, 1234.57]) {
      for (const mode of ['EXCLUSIVE', 'INCLUSIVE'] as const) {
        for (const rate of [7, 14, 20]) {
          const s = splitVatTotals(base, rate, mode);
          expect(roundMoney(s.net + s.vat)).toBe(s.gross);
        }
      }
    }
  });
});

describe('calcVatOnBase — формула бекенду', () => {
  it('EXCLUSIVE = round(base × rate / 100)', () => {
    expect(calcVatOnBase(7.59, 20, 'EXCLUSIVE')).toBe(1.52);
  });

  it('INCLUSIVE = round(base − base / (1 + rate/100))', () => {
    expect(calcVatOnBase(100, 20, 'INCLUSIVE')).toBe(16.67);
    expect(calcVatOnBase(1200, 20, 'INCLUSIVE')).toBe(200);
  });

  it('NONE → 0', () => {
    expect(calcVatOnBase(1200, 20, 'NONE')).toBe(0);
  });
});

// guards: BR-WO-007
describe('workOrderVatSplit — ПДВ збереженого наряду як totalAmount − totalNet', () => {
  it('ПДВ зверху: 1200 без ПДВ, 1440 до сплати → ПДВ 240', () => {
    expect(workOrderVatSplit({ totalAmount: 1440, totalNet: 1200 })).toEqual({
      net: 1200,
      vat: 240,
      gross: 1440,
    });
  });

  it('наряд, завершений до 2026-10-08 (totalNet = totalAmount) → ПДВ у сумі немає', () => {
    expect(workOrderVatSplit({ totalAmount: 1200, totalNet: 1200 })).toEqual({
      net: 1200,
      vat: 0,
      gross: 1200,
    });
  });

  it('totalNet відсутній у відповіді → ПДВ у сумі немає, без NaN', () => {
    expect(workOrderVatSplit({ totalAmount: 500 })).toEqual({ net: 500, vat: 0, gross: 500 });
    expect(workOrderVatSplit({ totalAmount: 500, totalNet: null })).toEqual({
      net: 500,
      vat: 0,
      gross: 500,
    });
  });

  it('float-дрейф різниці не дає «ПДВ 0,00» окремим рядком', () => {
    // 0.1 + 0.2 = 0.30000000000000004 — різниця з 0.3 менша за копійку.
    expect(workOrderVatSplit({ totalAmount: 0.1 + 0.2, totalNet: 0.3 }).vat).toBe(0);
  });
});

describe('roundMoney — дзеркало backend math.ts', () => {
  it('квантує до 2 знаків half-away-from-zero', () => {
    expect(roundMoney(1.005)).toBe(1.01); // +1e-9 нейтралізує 1.005 → 1.00
    expect(roundMoney(60.059999999999995)).toBe(60.06); // float-дрейф 300.3*0.2
    expect(roundMoney(2.5049)).toBe(2.5);
    expect(roundMoney(2.505)).toBe(2.51);
  });

  it('коректно для відʼємних (симетрично)', () => {
    expect(roundMoney(-1.005)).toBe(-1.01);
    expect(roundMoney(-0.004)).toBe(-0);
  });

  it('нескінченність/NaN → 0 (offline-safe)', () => {
    expect(roundMoney(Number.NaN)).toBe(0);
    expect(roundMoney(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('calcVatTotals — дзеркало backend work-orders recalcTotals', () => {
  it('Σ рядків квантується (немає float-дрейфу у total)', () => {
    // 0.1 + 0.2 = 0.30000000000000004 у сирому float; roundMoney лікує це.
    const { total, vat } = calcVatTotals(
      [
        { qty: 1, price: 0.1 },
        { qty: 1, price: 0.2 },
      ],
      0,
      'NONE',
    );
    expect(total).toBe(0.3);
    expect(vat).toBe(0);
  });

  it('VAT рахується на агрегованій базі (дзеркало recalcTotals, НЕ per-line)', () => {
    // recalcTotals: totalBase = Σ(per-line rounded), потім vat = roundMoney(base*rate/100)
    // ОДИН раз. Per-line-квантування ПДВ дало б preview на копійку більше за saved amount.
    // 3×2.525@20%: total = roundMoney(2.525)*3 = 2.53*3 = 7.59; vat = roundMoney(7.59*0.2)
    // = roundMoney(1.518) = 1.52 (per-line дало б 0.51*3 = 1.53 → розходження з backend).
    const { total, vat } = calcVatTotals(
      [
        { qty: 1, price: 2.525 },
        { qty: 1, price: 2.525 },
        { qty: 1, price: 2.525 },
      ],
      20,
      'EXCLUSIVE',
    );
    expect(total).toBe(7.59);
    expect(vat).toBe(1.52);
  });

  it('пропускає рядки з undefined qty/price', () => {
    const { total } = calcVatTotals(
      [
        { qty: undefined, price: 100 },
        { qty: 2, price: undefined },
        { qty: 3, price: 10 },
      ],
      0,
      'NONE',
    );
    expect(total).toBe(30);
  });

  it('reference — сумарний total стабільний на реальних цінах', () => {
    const { total } = calcVatTotals(
      [
        { qty: 3, price: 100.33 },
        { qty: 2, price: 49.99 },
      ],
      0,
      'NONE',
    );
    // 300.99 + 99.98 = 400.97 — точно, без хвостів.
    expect(total).toBe(400.97);
  });
});

// guards: BR-WO-007
describe('plannedWorkOrderAmount — закреслена «планова» сума в списку нарядів', () => {
  it('ПДВ зверху: план 1000 при факті 1200 → 1200 з ПДВ 20%, а не голі 1000', () => {
    // база факту 1200 (без ПДВ) → до сплати 1440; план 1000 → 1000 + 200 = 1200
    expect(
      plannedWorkOrderAmount({
        totalLabor: 800,
        totalActualLabor: 1000,
        totalParts: 200,
        totalNet: 1200,
        totalAmount: 1440,
      }),
    ).toBe(1200);
  });

  it('ПДВ у ціні: сума вже з ПДВ → план = планова база', () => {
    expect(
      plannedWorkOrderAmount({
        totalLabor: 800,
        totalActualLabor: 1000,
        totalParts: 200,
        totalNet: 1000,
        totalAmount: 1200,
      }),
    ).toBe(1000);
  });

  it('без ПДВ (totalNet = totalAmount) → планова база', () => {
    expect(
      plannedWorkOrderAmount({
        totalLabor: 800,
        totalActualLabor: 1000,
        totalParts: 200,
        totalNet: 1200,
        totalAmount: 1200,
      }),
    ).toBe(1000);
  });

  it('план = факту → totalAmount наряду як є; totalNet відсутній → планова база', () => {
    expect(
      plannedWorkOrderAmount({
        totalLabor: 1000,
        totalActualLabor: 1000,
        totalParts: 200,
        totalNet: 1200,
        totalAmount: 1440,
      }),
    ).toBe(1440);
    expect(
      plannedWorkOrderAmount({
        totalLabor: 800,
        totalActualLabor: 1000,
        totalParts: 200,
        totalAmount: 1200,
      }),
    ).toBe(1000);
  });
});

// guards: BR-WO-007
describe('lineAmount — сума рядка, округлена як на бекенді (Bug #811)', () => {
  it('0.3 × 100.05 = 30.02, а не 30.01 від toFixed на сирому добутку', () => {
    expect((0.3 * 100.05).toFixed(2)).toBe('30.01'); // сирий добуток 30.014999…
    expect(lineAmount(0.3, 100.05)).toBe(30.02);
    expect(lineAmount(1.5, 333.33)).toBe(500);
  });

  it('три рядки 0.3 × 111.11 складаються в 99.99 (сума округлених), а не в 100.00 (округлена сума сирих)', () => {
    const raw = 0.3 * 111.11 * 3;
    expect(roundMoney(raw)).toBe(100);
    const rounded = roundMoney(lineAmount(0.3, 111.11) * 3);
    expect(rounded).toBe(99.99);
    // те саме число дає calcVatTotals, яким модалка рахує планові роботи
    expect(calcVatTotals(Array(3).fill({ qty: 0.3, price: 111.11 }), 20, 'NONE').total).toBe(99.99);
  });
});
