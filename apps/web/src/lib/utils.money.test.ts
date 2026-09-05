import { describe, it, expect } from 'vitest';

import { roundMoney, calcVatTotals } from './utils';

// Regression-guard для клієнтського грошового квантування у модалках (WO-H2 / FIN-H1).
// Дзеркалить backend apps/api/src/common/utils/math.ts + vat.ts — обидві сторони мають
// округлювати ІДЕНТИЧНО, інакше preview-сума у tfoot розходиться з бекендовим amount.

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
    );
    // 300.99 + 99.98 = 400.97 — точно, без хвостів.
    expect(total).toBe(400.97);
  });
});
