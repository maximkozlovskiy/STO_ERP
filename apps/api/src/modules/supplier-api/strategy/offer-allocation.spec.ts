import { describe, expect, it } from 'vitest';
import {
  allocateOffers,
  effectiveDays,
  roundUpToStep,
  type AllocationOffer,
  type AllocationOptions,
} from './offer-allocation';

/** Стратегії автопідбору (BR-SOFR-007) і покриття кількості (BR-SOFR-008) — вичерпні таблиці. */
const NOW = new Date('2026-10-18T09:00:00Z');
const opts = (over: Partial<AllocationOptions> = {}): AllocationOptions => ({
  strategy: 'CHEAP',
  priceWeight: 0.7,
  allowSplit: true,
  unknownDeliveryDays: 7,
  now: NOW,
  ...over,
});
let seq = 0;
const offer = (over: Partial<AllocationOffer> = {}): AllocationOffer => {
  seq += 1;
  return {
    id: `o${String(seq).padStart(3, '0')}`,
    supplierId: 'sup-A',
    connectionPriority: 100,
    offerKey: `k${String(seq).padStart(3, '0')}`,
    priceUah: 100,
    qty: 10,
    qtyIsLowerBound: false,
    multiplicity: null,
    deliveryDays: 3,
    deliveryDate: null,
    connectionDefaultDays: null,
    selectable: true,
    ...over,
  };
};
const ids = (r: ReturnType<typeof allocateOffers>) => r.parts.map(p => [p.offerId, p.qty]);

/** Усі перестановки (для перевірки детермінованості). */
function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]),
  );
}

describe('BR-SOFR-007 стратегії', () => {
  // guards: BR-SOFR-007
  it('CHEAP: найменша сума; нічия за сумою → коротший термін', () => {
    const a = offer({ id: 'A', priceUah: 120, deliveryDays: 1 });
    const b = offer({ id: 'B', priceUah: 100, deliveryDays: 5 });
    const c = offer({ id: 'C', priceUah: 100, deliveryDays: 2 });
    expect(ids(allocateOffers(4, [a, b, c], opts()))).toEqual([['C', 4]]);
  });

  // guards: BR-SOFR-007
  it('CHEAP рахує СУМУ замовлення з кратністю, а не ціну одиниці', () => {
    // 3 шт: кратність 5 → 5 × 60 = 300; без кратності 3 × 90 = 270.
    const pack = offer({ id: 'PACK', priceUah: 60, multiplicity: 5 });
    const single = offer({ id: 'ONE', priceUah: 90 });
    expect(ids(allocateOffers(3, [pack, single], opts()))).toEqual([['ONE', 3]]);
  });

  // guards: BR-SOFR-007
  it('FAST: найкоротший термін; нічия за терміном → менша сума', () => {
    const a = offer({ id: 'A', priceUah: 80, deliveryDays: 4 });
    const b = offer({ id: 'B', priceUah: 150, deliveryDays: 1 });
    const c = offer({ id: 'C', priceUah: 120, deliveryDays: 1 });
    expect(ids(allocateOffers(2, [a, b, c], opts({ strategy: 'FAST' })))).toEqual([['C', 2]]);
  });

  // guards: BR-SOFR-007
  it('OPTIMAL: w = 1 — як дешево, w = 0 — як швидко, w = 0.5 — компроміс за нормуванням min–max', () => {
    const cheapSlow = offer({ id: 'CHEAP', priceUah: 100, deliveryDays: 10 });
    const dearFast = offer({ id: 'FAST', priceUah: 200, deliveryDays: 0 });
    const middle = offer({ id: 'MID', priceUah: 130, deliveryDays: 2 });
    const all = [cheapSlow, dearFast, middle];
    expect(ids(allocateOffers(1, all, opts({ strategy: 'OPTIMAL', priceWeight: 1 })))).toEqual([
      ['CHEAP', 1],
    ]);
    expect(ids(allocateOffers(1, all, opts({ strategy: 'OPTIMAL', priceWeight: 0 })))).toEqual([
      ['FAST', 1],
    ]);
    // MID: 0.5·0.3 + 0.5·0.2 = 0.25 < CHEAP 0.5 і FAST 0.5.
    expect(ids(allocateOffers(1, all, opts({ strategy: 'OPTIMAL', priceWeight: 0.5 })))).toEqual([
      ['MID', 1],
    ]);
  });

  // guards: BR-SOFR-007
  it('остаточна нічия — priority підключення, далі offerKey; результат не залежить від порядку', () => {
    const p1 = offer({ id: 'P1', connectionPriority: 20, offerKey: 'z' });
    const p2 = offer({ id: 'P2', connectionPriority: 10, offerKey: 'y' });
    const p3 = offer({ id: 'P3', connectionPriority: 10, offerKey: 'x' });
    for (const strategy of ['CHEAP', 'FAST', 'OPTIMAL'] as const) {
      const results = permutations([p1, p2, p3]).map(perm =>
        ids(allocateOffers(5, perm, opts({ strategy }))),
      );
      for (const r of results) expect(r).toEqual([['P3', 5]]);
    }
  });

  // guards: BR-SOFR-007
  it('термін: deliveryDays → дні до deliveryDate → термін підключення → штраф за невідомий', () => {
    const base = { now: NOW, unknownDeliveryDays: 9 };
    expect(
      effectiveDays(
        offer({ deliveryDays: 2, deliveryDate: new Date('2026-10-30T00:00:00Z') }),
        base,
      ),
    ).toBe(2);
    expect(
      effectiveDays(
        offer({ deliveryDays: null, deliveryDate: new Date('2026-10-21T12:00:00Z') }),
        base,
      ),
    ).toBe(4);
    expect(effectiveDays(offer({ deliveryDays: null, connectionDefaultDays: 1 }), base)).toBe(1);
    expect(effectiveDays(offer({ deliveryDays: null }), base)).toBe(9);
    // Невідомий термін програє відомому за стратегії FAST.
    const unknown = offer({ id: 'U', deliveryDays: null, priceUah: 50 });
    const known = offer({ id: 'K', deliveryDays: 5, priceUah: 90 });
    expect(
      ids(allocateOffers(1, [unknown, known], opts({ strategy: 'FAST', unknownDeliveryDays: 7 }))),
    ).toEqual([['K', 1]]);
  });

  // guards: BR-SOFR-007
  it('без курсу (priceUah = null) і не дозволені до вибору — не беруть участі', () => {
    const noRate = offer({ id: 'EUR', priceUah: null });
    const analog = offer({ id: 'ANALOG', priceUah: 10, selectable: false });
    const ok = offer({ id: 'OK', priceUah: 500 });
    expect(ids(allocateOffers(1, [noRate, analog, ok], opts()))).toEqual([['OK', 1]]);
    expect(allocateOffers(3, [noRate, analog], opts())).toEqual({ parts: [], uncovered: 3 });
  });
});

describe('BR-SOFR-008 покриття кількості', () => {
  // guards: BR-SOFR-008
  it('перша — найкраща пропозиція, що покриває ВСЮ потребу, навіть якщо дешевша покриває частину', () => {
    const cheapPartial = offer({ id: 'PART', priceUah: 50, qty: 2 });
    const full = offer({ id: 'FULL', priceUah: 80, qty: 10 });
    expect(allocateOffers(5, [cheapPartial, full], opts())).toEqual({
      parts: [{ offerId: 'FULL', qty: 5, priceUah: 80, days: 3 }],
      uncovered: 0,
    });
  });

  // guards: BR-SOFR-008
  it('кратність: до кратності вгору (надлишок допускається); не вміщається в наявне — не покриває', () => {
    expect(roundUpToStep(3, 2)).toBe(4);
    const m2 = offer({ id: 'M2', multiplicity: 2, qty: 4 });
    expect(ids(allocateOffers(3, [m2], opts()))).toEqual([['M2', 4]]);
    const m4 = offer({ id: 'M4', multiplicity: 4, qty: 6 }); // замовити можна лише 4
    expect(allocateOffers(5, [m4], opts())).toEqual({
      parts: [{ offerId: 'M4', qty: 4, priceUah: 100, days: 3 }],
      uncovered: 1,
    });
  });

  // guards: BR-SOFR-008
  it('дробові частини: залишок плаваючої коми не стає «непокритою» потребою', () => {
    // 1.1 − 0.2 − 0.9 у double = 1.1e-16, а не 0.
    const a = offer({ id: 'A', qty: 0.2, multiplicity: 0.1, priceUah: 10 });
    const b = offer({ id: 'B', qty: 0.9, multiplicity: 0.1, priceUah: 20 });
    const r = allocateOffers(1.1, [a, b], opts());
    expect(r.parts.map(p => p.offerId)).toEqual(['A', 'B']);
    expect(r.uncovered).toBe(0);
  });

  // guards: BR-SOFR-008
  it('обмежена кількість («>10») вважається рівною межі', () => {
    const capped = offer({ id: 'CAP', qty: 10, qtyIsLowerBound: true });
    expect(allocateOffers(12, [capped], opts())).toEqual({
      parts: [{ offerId: 'CAP', qty: 10, priceUah: 100, days: 3 }],
      uncovered: 2,
    });
  });

  // guards: BR-SOFR-008
  it('між складами одного постачальника ділить завжди (allowSplit = false)', () => {
    const wh1 = offer({ id: 'A-1', supplierId: 'A', qty: 3, priceUah: 90 });
    const wh2 = offer({ id: 'A-2', supplierId: 'A', qty: 5, priceUah: 95 });
    const other = offer({ id: 'B-1', supplierId: 'B', qty: 5, priceUah: 92 });
    expect(allocateOffers(6, [wh1, wh2, other], opts({ allowSplit: false }))).toEqual({
      parts: [
        { offerId: 'A-1', qty: 3, priceUah: 90, days: 3 },
        { offerId: 'A-2', qty: 3, priceUah: 95, days: 3 },
      ],
      uncovered: 0,
    });
  });

  // guards: BR-SOFR-008
  it('між різними постачальниками — лише з allowSplit; без нього решта лишається непокритою', () => {
    const a = offer({ id: 'A', supplierId: 'A', qty: 4, priceUah: 90 });
    const b = offer({ id: 'B', supplierId: 'B', qty: 4, priceUah: 95 });
    expect(allocateOffers(6, [a, b], opts({ allowSplit: true }))).toEqual({
      parts: [
        { offerId: 'A', qty: 4, priceUah: 90, days: 3 },
        { offerId: 'B', qty: 2, priceUah: 95, days: 3 },
      ],
      uncovered: 0,
    });
    expect(allocateOffers(6, [a, b], opts({ allowSplit: false }))).toEqual({
      parts: [{ offerId: 'A', qty: 4, priceUah: 90, days: 3 }],
      uncovered: 2,
    });
  });

  // guards: BR-SOFR-008
  it('жадібний поділ іде за оцінкою стратегії (FAST — спершу найшвидший склад)', () => {
    const slowCheap = offer({ id: 'SLOW', qty: 3, priceUah: 50, deliveryDays: 9 });
    const fastDear = offer({ id: 'QUICK', qty: 3, priceUah: 99, deliveryDays: 1 });
    expect(ids(allocateOffers(5, [slowCheap, fastDear], opts({ strategy: 'FAST' })))).toEqual([
      ['QUICK', 3],
      ['SLOW', 2],
    ]);
    expect(ids(allocateOffers(5, [slowCheap, fastDear], opts({ strategy: 'CHEAP' })))).toEqual([
      ['SLOW', 3],
      ['QUICK', 2],
    ]);
  });

  it('нульова потреба — нічого; пропозицій немає — уся потреба непокрита', () => {
    expect(allocateOffers(0, [offer()], opts())).toEqual({ parts: [], uncovered: 0 });
    expect(allocateOffers(2, [], opts())).toEqual({ parts: [], uncovered: 2 });
  });
});
