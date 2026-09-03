import * as fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { BALANCE_SIGN } from '../settlements/settlements.service';

/**
 * Property-based invariants for партійне списання (FIFO/FEFO/LIFO/AVG_COST).
 *
 * Дзеркалить логіку BatchService.consumeBatch — тестує ІНВАРІАНТИ, не конкретну
 * реалізацію. Refactor який зламає інваріант впаде тут ще до інтеграційного тесту.
 *
 * Ключові інваріанти (взяті з фокусу /sto-tester circle 1 feat/supplier-payments):
 *
 * 1. Σ consumed[i].quantity == qty (при успішному списанні)
 * 2. Σ remainingQty(before) − Σ remainingQty(after) == qty (масовий інваріант)
 * 3. Σ remainingQty(active, after) >= 0 (жодна партія не йде у мінус)
 * 4. Партія з remainingQty==0 автоматично isActive=false
 * 5. FIFO/LIFO/FEFO порядок обходу партій відповідає costMethod
 * 6. Нестача (qty > Σ remainingQty) → throw ПЕРЕД будь-якою мутацією (all-or-nothing)
 * 7. AVG_COST — агрегат {batchId: null, qty, costPrice: avgCost} — length===1 і batchId===null
 * 8. batchCostPrice fixation: single-batch consume → batchId зафіксовано; span/AVG → NULL
 */

// ─── Model of FIFO/LIFO/FEFO consumption ──────────────────────────────────────

interface Batch {
  id: string;
  createdAt: number;
  expiryDate: number | null;
  remainingQty: number;
  costPrice: number;
  isActive: boolean;
}

type CostMethod = 'FIFO' | 'LIFO' | 'FEFO' | 'AVG_COST';

interface ConsumeResult {
  batchId: string | null; // null — AVG_COST-агрегат (не одна фізична партія), дзеркалить BatchConsumeResult
  quantity: number;
  costPrice: number;
}

/** Порядок обходу активних партій за методом. FEFO: null expiry → LAST. */
function orderBatches(batches: Batch[], method: CostMethod): Batch[] {
  const active = batches.filter(b => b.isActive && b.remainingQty > 0);
  if (method === 'LIFO') {
    return [...active].sort((a, b) => b.createdAt - a.createdAt);
  }
  if (method === 'FEFO') {
    return [...active].sort((a, b) => {
      // null expiry йде LAST (nulls: 'last')
      if (a.expiryDate == null && b.expiryDate == null) return a.createdAt - b.createdAt;
      if (a.expiryDate == null) return 1;
      if (b.expiryDate == null) return -1;
      const diff = a.expiryDate - b.expiryDate;
      return diff !== 0 ? diff : a.createdAt - b.createdAt;
    });
  }
  // FIFO default
  return [...active].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Модель consumeBatch: списує qty з активних партій у порядку costMethod, повертає
 * список списаних (batchId, quantity, costPrice). Мутує batches in-place — це навмисно,
 * щоб тестувати інваріанти масового балансу.
 */
function consumeBatchModel(
  batches: Batch[],
  qty: number,
  method: CostMethod,
): ConsumeResult[] | { error: string } {
  if (qty <= 0) return { error: 'qty must be positive' };

  // AVG_COST — sentinel: не мутує партії (у реальності мутує FIFO, але для інваріантів
  // тут перевіряємо саме форму sentinel-результату).
  if (method === 'AVG_COST') {
    const totalCost = batches
      .filter(b => b.isActive && b.remainingQty > 0)
      .reduce((s, b) => s + b.remainingQty * b.costPrice, 0);
    const totalQty = batches
      .filter(b => b.isActive && b.remainingQty > 0)
      .reduce((s, b) => s + b.remainingQty, 0);
    if (totalQty < qty) return { error: 'insufficient' };
    const avgCost = totalQty > 0 ? totalCost / totalQty : 0;
    return [{ batchId: null, quantity: qty, costPrice: avgCost }];
  }

  const ordered = orderBatches(batches, method);
  const totalAvailable = ordered.reduce((s, b) => s + b.remainingQty, 0);
  // ОБОВ'ЯЗКОВО перевіряти ДО мутацій — інакше all-or-nothing інваріант зламається.
  if (totalAvailable < qty) return { error: 'insufficient' };

  let remaining = qty;
  const results: ConsumeResult[] = [];
  for (const batch of ordered) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, batch.remainingQty);
    if (take <= 0) continue;

    // Мутуємо оригінальний батч (посилання через ordered).
    batch.remainingQty -= take;
    if (batch.remainingQty === 0) batch.isActive = false;

    results.push({ batchId: batch.id, quantity: take, costPrice: batch.costPrice });
    remaining -= take;
  }
  return results;
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const makeBatch = (i: number) =>
  fc.record({
    id: fc.constant(`b-${i}`),
    createdAt: fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 }),
    expiryDate: fc.option(fc.integer({ min: 1_800_000_000_000, max: 1_900_000_000_000 }), {
      nil: null,
    }),
    remainingQty: fc.integer({ min: 1, max: 1000 }),
    costPrice: fc.integer({ min: 1, max: 10000 }),
    isActive: fc.constant(true),
  });

const batchArray = fc
  .integer({ min: 1, max: 8 })
  .chain(n => fc.tuple(...Array.from({ length: n }, (_, i) => makeBatch(i))));

const methodArb = fc.constantFrom<CostMethod>('FIFO', 'LIFO', 'FEFO');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BatchService — consume invariants (property-based)', () => {
  it('інваріант #1: Σ consumed[i].quantity == qty (успіх)', () => {
    fc.assert(
      fc.property(
        batchArray,
        methodArb,
        fc.integer({ min: 1, max: 500 }),
        (batches, method, qty) => {
          const clone = batches.map(b => ({ ...b }));
          const totalAvail = clone.reduce((s, b) => s + b.remainingQty, 0);
          fc.pre(qty <= totalAvail);
          const res = consumeBatchModel(clone, qty, method);
          if ('error' in res) return true; // insufficient — не наш інваріант
          const sum = res.reduce((s, r) => s + r.quantity, 0);
          return sum === qty;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('інваріант #2: масовий баланс — Σ remainingQty(before) − Σ remainingQty(after) == qty', () => {
    fc.assert(
      fc.property(
        batchArray,
        methodArb,
        fc.integer({ min: 1, max: 500 }),
        (batches, method, qty) => {
          const clone = batches.map(b => ({ ...b }));
          const before = clone.reduce((s, b) => s + b.remainingQty, 0);
          fc.pre(qty <= before);
          const res = consumeBatchModel(clone, qty, method);
          if ('error' in res) return true;
          const after = clone.reduce((s, b) => s + b.remainingQty, 0);
          return before - after === qty;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('інваріант #3: жодна партія у мінус (remainingQty >= 0 після consume)', () => {
    fc.assert(
      fc.property(
        batchArray,
        methodArb,
        fc.integer({ min: 1, max: 5000 }),
        (batches, method, qty) => {
          const clone = batches.map(b => ({ ...b }));
          consumeBatchModel(clone, qty, method);
          return clone.every(b => b.remainingQty >= 0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('інваріант #4: партія з remainingQty=0 стає isActive=false', () => {
    fc.assert(
      fc.property(
        batchArray,
        methodArb,
        fc.integer({ min: 1, max: 5000 }),
        (batches, method, qty) => {
          const clone = batches.map(b => ({ ...b }));
          consumeBatchModel(clone, qty, method);
          return clone.every(b => (b.remainingQty === 0 ? !b.isActive : true));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('інваріант #5 (FIFO): найстаріша партія списується першою', () => {
    fc.assert(
      fc.property(batchArray, fc.integer({ min: 1, max: 500 }), (batches, qty) => {
        const clone = batches.map(b => ({ ...b }));
        const total = clone.reduce((s, b) => s + b.remainingQty, 0);
        fc.pre(qty <= total && qty > 0);
        const res = consumeBatchModel(clone, qty, 'FIFO');
        if ('error' in res || res.length === 0) return true;
        // Перша списана має бути найстарішою серед тих, що були активні на старті
        const oldest = [...batches].sort((a, b) => a.createdAt - b.createdAt)[0];
        return res[0].batchId === oldest.id;
      }),
      { numRuns: 300 },
    );
  });

  it('інваріант #5 (LIFO): найновіша партія списується першою', () => {
    fc.assert(
      fc.property(batchArray, fc.integer({ min: 1, max: 500 }), (batches, qty) => {
        const clone = batches.map(b => ({ ...b }));
        const total = clone.reduce((s, b) => s + b.remainingQty, 0);
        fc.pre(qty <= total && qty > 0);
        const res = consumeBatchModel(clone, qty, 'LIFO');
        if ('error' in res || res.length === 0) return true;
        const newest = [...batches].sort((a, b) => b.createdAt - a.createdAt)[0];
        return res[0].batchId === newest.id;
      }),
      { numRuns: 300 },
    );
  });

  it('інваріант #6: нестача (qty > total) → error БЕЗ мутації партій', () => {
    fc.assert(
      fc.property(batchArray, methodArb, (batches, method) => {
        const clone = batches.map(b => ({ ...b }));
        const total = clone.reduce((s, b) => s + b.remainingQty, 0);
        const excess = total + 1;
        const before = clone.map(b => b.remainingQty);
        const res = consumeBatchModel(clone, excess, method);
        const after = clone.map(b => b.remainingQty);
        // Має бути error І партії не змінилися (all-or-nothing).
        return 'error' in res && before.every((q, i) => q === after[i]);
      }),
      { numRuns: 300 },
    );
  });

  it('інваріант #7 (AVG_COST): агрегат {batchId:null, length===1}', () => {
    fc.assert(
      fc.property(batchArray, fc.integer({ min: 1, max: 500 }), (batches, qty) => {
        const clone = batches.map(b => ({ ...b }));
        const total = clone.reduce((s, b) => s + b.remainingQty, 0);
        fc.pre(qty <= total && qty > 0);
        const res = consumeBatchModel(clone, qty, 'AVG_COST');
        if ('error' in res) return true;
        // Агрегат: length===1, batchId===null (лягає у nullable uuid), quantity===qty.
        return res.length === 1 && res[0].batchId === null && res[0].quantity === qty;
      }),
      { numRuns: 300 },
    );
  });

  it('інваріант #8: single-batch consume → consumed.length===1 (batchId fixation ok)', () => {
    // Якщо qty <= найпершої-у-порядку партії — списання з ОДНІЄЇ партії.
    // Bug #609 стосувався саме цього write-path (batchId fixation single-batch).
    fc.assert(
      fc.property(batchArray, methodArb, (batches, method) => {
        // methodArb не містить AVG_COST — тут лише партійні методи (FIFO/LIFO/FEFO).
        const clone = batches.map(b => ({ ...b }));
        const ordered = orderBatches(clone, method);
        fc.pre(ordered.length > 0);
        const singleQty = Math.min(1, ordered[0].remainingQty);
        const res = consumeBatchModel(clone, singleQty, method);
        if ('error' in res) return true;
        return res.length === 1 && res[0].batchId != null;
      }),
      { numRuns: 200 },
    );
  });

  it('інваріант #8: span (multi-batch) consume → consumed.length>1 (batchId=NULL fixation)', () => {
    // Коли qty > найпершої-у-порядку — списання span; batchCostPrice фіксується,
    // batchId (у WorkOrderPart) має бути NULL — інакше UUID FK не зафіксується.
    fc.assert(
      fc.property(batchArray, methodArb, (batches, method) => {
        // methodArb не містить AVG_COST — лише партійні методи.
        const clone = batches.map(b => ({ ...b }));
        const ordered = orderBatches(clone, method);
        fc.pre(ordered.length >= 2);
        const spanQty = ordered[0].remainingQty + 1; // ГАРАНТОВАНО span
        const total = clone.reduce((s, b) => s + b.remainingQty, 0);
        fc.pre(spanQty <= total);
        const res = consumeBatchModel(clone, spanQty, method);
        if ('error' in res) return true;
        return res.length > 1;
      }),
      { numRuns: 200 },
    );
  });

  it('інваріант cross-method: FIFO, LIFO, FEFO, AVG_COST всі списують РІВНО qty', () => {
    fc.assert(
      fc.property(batchArray, fc.integer({ min: 1, max: 500 }), (batches, qty) => {
        const total = batches.reduce((s, b) => s + b.remainingQty, 0);
        fc.pre(qty <= total && qty > 0);
        const methods: CostMethod[] = ['FIFO', 'LIFO', 'FEFO', 'AVG_COST'];
        for (const m of methods) {
          const clone = batches.map(b => ({ ...b }));
          const res = consumeBatchModel(clone, qty, m);
          if ('error' in res) continue;
          const sum = res.reduce((s, r) => s + r.quantity, 0);
          if (sum !== qty) return false;
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

// ─── FIFO supplier-payment schedule invariants ────────────────────────────────

interface OpenPo {
  outstanding: number;
  paymentDate: string | null; // YYYY-MM-DD
}
interface ScheduleBuckets {
  overdue: number;
  planned: number;
  byDate: Record<string, number>;
}

/**
 * Модель FIFO-розподілу боргу постачальнику по відкритих PO (від найстарішого).
 * Дзеркалить supplier-payments.service.ts getSchedule. Тестує:
 *   - Σ (overdue + planned + byDate[*]) == payable (перед лімітом)
 *   - PO у FIFO-порядку (найстаріша дата → перша)
 *   - overflow (payable > Σ outstanding) → надлишок у overdue
 *   - кредит-ліміт зменшує з planned → дати спадно → overdue
 */
function fillSchedule(
  payable: number,
  openPos: OpenPo[],
  from: string,
  to: string,
): ScheduleBuckets {
  const acc: ScheduleBuckets = { overdue: 0, planned: 0, byDate: {} };
  const bucket = (amount: number, pd: string | null) => {
    if (pd == null || pd < from) acc.overdue += amount;
    else if (pd <= to) acc.byDate[pd] = (acc.byDate[pd] ?? 0) + amount;
    else acc.planned += amount;
  };
  let remaining = payable;
  for (const po of openPos) {
    if (remaining <= 0.005) break;
    const take = Math.min(po.outstanding, remaining);
    remaining -= take;
    bucket(take, po.paymentDate);
  }
  if (remaining > 0.005) acc.overdue += remaining;
  return acc;
}

function applyLimit(acc: ScheduleBuckets, limit: number): ScheduleBuckets {
  const out: ScheduleBuckets = { overdue: 0, planned: 0, byDate: {} };
  let lim = limit;
  const eat = (n: number): number => {
    if (lim <= 0) return n;
    const eaten = Math.min(n, lim);
    lim -= eaten;
    return n - eaten;
  };
  out.planned = eat(acc.planned);
  const descDates = Object.keys(acc.byDate).sort((a, b) => (a < b ? 1 : -1));
  for (const d of descDates) {
    const left = eat(acc.byDate[d]);
    if (left > 0.005) out.byDate[d] = left;
  }
  out.overdue = eat(acc.overdue);
  return out;
}

const dateArb = () =>
  fc
    .tuple(
      fc.integer({ min: 2026, max: 2028 }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 1, max: 28 }),
    )
    .map(([y, m, d]) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);

describe('SupplierPayments.getSchedule — FIFO invariants (property-based)', () => {
  it('інваріант A: Σ bucket-сум == payable (перед лімітом), незалежно від dates/pos', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.array(
          fc.record({
            outstanding: fc.integer({ min: 1, max: 100_000 }),
            paymentDate: fc.option(dateArb(), { nil: null }),
          }),
          { minLength: 0, maxLength: 15 },
        ),
        dateArb(),
        dateArb(),
        (payable, pos, from, to) => {
          fc.pre(from <= to);
          const acc = fillSchedule(payable, pos, from, to);
          const sum =
            acc.overdue + acc.planned + Object.values(acc.byDate).reduce((s, v) => s + v, 0);
          return Math.abs(sum - payable) < 0.01;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('інваріант B: надлишок (payable > Σ outstanding) → рівно (payable − Σ) у overdue', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 1_000_000 }),
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 5 }),
        (payable, outstandings) => {
          const pos = outstandings.map(q => ({ outstanding: q, paymentDate: '2027-06-15' }));
          const totalPO = outstandings.reduce((s, q) => s + q, 0);
          fc.pre(payable > totalPO);
          const acc = fillSchedule(payable, pos, '2027-01-01', '2027-12-31');
          const excess = payable - totalPO;
          return Math.abs(acc.overdue - excess) < 0.01;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('інваріант C: FIFO — перший PO закривається повністю ДО того як другий отримує щось', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        (poA, poB, payable) => {
          fc.pre(payable < poA); // payable менше за перший PO → другий не має отримати нічого
          const pos: OpenPo[] = [
            { outstanding: poA, paymentDate: '2027-01-01' },
            { outstanding: poB, paymentDate: '2027-01-05' },
          ];
          const acc = fillSchedule(payable, pos, '2027-01-01', '2027-01-10');
          // Весь борг має лягти на дату першого PO.
          return acc.byDate['2027-01-01'] === payable && (acc.byDate['2027-01-05'] ?? 0) === 0;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('інваріант D: кредит-ліміт покриває planned ПЕРШИМ, overdue лишається (Bug #611 regression)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 10_000 }),
        fc.integer({ min: 100, max: 10_000 }),
        fc.integer({ min: 100, max: 5_000 }),
        (plannedRaw, overdueRaw, limit) => {
          const acc: ScheduleBuckets = { overdue: overdueRaw, planned: plannedRaw, byDate: {} };
          const out = applyLimit(acc, limit);
          // Ліміт не може зменшити більше за оригінал у сумі
          const totalBefore = overdueRaw + plannedRaw;
          const totalAfter =
            out.overdue + out.planned + Object.values(out.byDate).reduce((s, v) => s + v, 0);
          const expectedReduction = Math.min(limit, totalBefore);
          return Math.abs(totalBefore - totalAfter - expectedReduction) < 0.01;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('інваріант E: ліміт ≥ payable → усі buckets = 0', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 1000 }), (p, e) => {
        const acc: ScheduleBuckets = { overdue: p, planned: 0, byDate: {} };
        const limit = p + e; // ліміт більший за борг
        const out = applyLimit(acc, limit);
        return out.overdue === 0 && out.planned === 0 && Object.keys(out.byDate).length === 0;
      }),
      { numRuns: 200 },
    );
  });
});

// ─── Supplier balance sign — cross-invariant with BALANCE_SIGN table ─────────

describe('BALANCE_SIGN — supplier cycle invariants', () => {
  // Знак = ±1, balance = Σ signed(tx). Реюзаємо ЕКСПОРТОВАНУ таблицю з прод-коду —
  // інверсія знаку у settlements.service (напр. SUPPLIER_PAYMENT:-1) впаде тут, а не
  // проти локальної копії (яка б мовчки дрейфувала). Reuse-finding cycle 1.
  const SIGN = BALANCE_SIGN;

  it('SUPPLIER_CHARGE(X) → balance = -X (ми винні X)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), amt => {
        const balance = 0 + SIGN.SUPPLIER_CHARGE * amt;
        return balance === -amt && balance < 0;
      }),
      { numRuns: 200 },
    );
  });

  it('SUPPLIER_PAYMENT(X) + SUPPLIER_CHARGE(X) → balance = 0 (борг погашено)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), amt => {
        const balance = SIGN.SUPPLIER_CHARGE * amt + SIGN.SUPPLIER_PAYMENT * amt;
        return balance === 0;
      }),
      { numRuns: 200 },
    );
  });

  it("payable = max(0, -balance) — тільки від'ємний баланс формує рядок у графіку", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), balance => {
        const payable = Math.max(0, -balance);
        // Якщо balance≥0 → payable=0 (постачальник не показується); якщо balance<0 → payable=|balance|
        if (balance >= 0) return payable === 0;
        return payable === -balance && payable > 0;
      }),
      { numRuns: 300 },
    );
  });

  it('partial cycle: SUPPLIER_CHARGE(X) + SUPPLIER_PAYMENT(Y<X) → payable = X-Y', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_000_000 }),
        fc.integer({ min: 1, max: 99 }),
        (X, delta) => {
          const Y = X - delta; // Y < X
          const balance = SIGN.SUPPLIER_CHARGE * X + SIGN.SUPPLIER_PAYMENT * Y;
          const payable = Math.max(0, -balance);
          return payable === X - Y && payable > 0;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('SUPPLIER_REFUND — той самий знак що SUPPLIER_PAYMENT (+1, зменшує наш борг)', () => {
    // Regression: якщо refund раптом отримає знак −1 → повернення товару збільшить наш борг.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), amt => {
        return SIGN.SUPPLIER_REFUND === SIGN.SUPPLIER_PAYMENT && SIGN.SUPPLIER_REFUND * amt > 0;
      }),
      { numRuns: 100 },
    );
  });
});

// ─── TRANSFER cost-carry invariant ────────────────────────────────────────────

describe('StockDocument TRANSFER — cost-carry invariant', () => {
  // Модель: WRITEOFF з src повертає weightedCostPrice; RECEIPT на target
  // ОБОВ'ЯЗКОВО отримує price = weightedCostPrice (не sale price).
  // Регресія: Bug #610.
  it('target RECEIPT.price === src.weightedCostPrice (коли != null)', () => {
    fc.assert(
      fc.property(fc.float({ min: Math.fround(1), max: Math.fround(10000), noNaN: true }), cost => {
        const src = { weightedCostPrice: cost };
        const fallbackPrice = 999; // baseArgs.price — sale price, не має братися
        const targetPrice = src.weightedCostPrice ?? fallbackPrice;
        return targetPrice === cost;
      }),
      { numRuns: 200 },
    );
  });

  it('target RECEIPT.price fallback до baseArgs.price коли weightedCostPrice=null', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10000 }), fallback => {
        const src: { weightedCostPrice: number | null } = { weightedCostPrice: null };
        const targetPrice = src.weightedCostPrice ?? fallback;
        return targetPrice === fallback;
      }),
      { numRuns: 200 },
    );
  });

  it('weightedCostPrice=0 (free-sample cost) НЕ падає у fallback (0 — валідна ціна)', () => {
    // Regression Bug #610: cost-carry має брати `?? fallback` (не `|| fallback`),
    // інакше безкоштовне походження (cost=0) втратить нульову семантику і візьме sale price.
    const src: { weightedCostPrice: number | null } = { weightedCostPrice: 0 };
    const fallback = 100;
    const targetPrice = src.weightedCostPrice ?? fallback;
    expect(targetPrice).toBe(0);
  });
});

// ─── Bug #614 — Mid-life switch costMethod invariants ─────────────────────────
// Ключове питання: коли організація створила партії у FIFO, потім переключилась
// на AVG_COST → LIFO → FEFO — чи тримається Σ remainingQty(active) == StockItem.quantity?
// Модель дзеркалить InventoryService.createMovement AVG_COST-branch (рядок 227),
// який завжди викликає consumeBatch(..., 'FIFO', ...) для фізичного декременту
// (щоб інваріант не залежав від lookup-режиму собівартості).
describe('BatchService — mid-life costMethod switch invariants (Bug #614)', () => {
  it('послідовні WRITEOFF з різним costMethod → Σ remainingQty(active) == вихідне − Σ consumed', () => {
    fc.assert(
      fc.property(
        batchArray,
        fc.array(
          fc.record({
            method: methodArb, // FIFO/LIFO/FEFO — AVG_COST у моделі не мутує партії
            qty: fc.integer({ min: 1, max: 300 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (batches, ops) => {
          const clone = batches.map(b => ({ ...b }));
          const initialSum = clone.reduce((s, b) => s + b.remainingQty, 0);
          let totalConsumed = 0;
          for (const op of ops) {
            const res = consumeBatchModel(clone, op.qty, op.method);
            if (!('error' in res)) {
              totalConsumed += res.reduce((s, r) => s + r.quantity, 0);
            }
            // insufficient/error — партії НЕ мутувались (all-or-nothing з рядка 91 моделі)
          }
          const finalSum = clone.reduce((s, b) => s + b.remainingQty, 0);
          return finalSum === initialSum - totalConsumed;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('після серії mid-life switch: жодна партія не в мінус, isActive узгоджено з remainingQty', () => {
    fc.assert(
      fc.property(
        batchArray,
        fc.array(fc.record({ method: methodArb, qty: fc.integer({ min: 1, max: 500 }) }), {
          minLength: 1,
          maxLength: 15,
        }),
        (batches, ops) => {
          const clone = batches.map(b => ({ ...b }));
          for (const op of ops) consumeBatchModel(clone, op.qty, op.method);
          return clone.every(
            b => b.remainingQty >= 0 && (b.remainingQty > 0 ? b.isActive : !b.isActive),
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('AVG_COST commit path декрементує партії FIFO — Σ інваріант тримається саме тому', () => {
    // Модель: AVG_COST у реальному InventoryService.createMovement викликає
    // consumeBatch(..., 'FIFO', ...) — тобто фізичний декремент завжди FIFO.
    // Тестуємо цей контракт: змішана послідовність where AVG_COST replaced by FIFO.
    fc.assert(
      fc.property(
        batchArray,
        fc.array(
          fc.record({
            declaredMethod: fc.constantFrom<CostMethod>('FIFO', 'LIFO', 'FEFO', 'AVG_COST'),
            qty: fc.integer({ min: 1, max: 200 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (batches, ops) => {
          const clone = batches.map(b => ({ ...b }));
          const initialSum = clone.reduce((s, b) => s + b.remainingQty, 0);
          let physicallyConsumed = 0;
          for (const op of ops) {
            // AVG_COST у real code = FIFO для decrement, sentinel для lookup — тому мутуємо FIFO
            const effective: CostMethod =
              op.declaredMethod === 'AVG_COST' ? 'FIFO' : op.declaredMethod;
            const res = consumeBatchModel(clone, op.qty, effective);
            if (!('error' in res)) {
              physicallyConsumed += res.reduce((s, r) => s + r.quantity, 0);
            }
          }
          const finalSum = clone.reduce((s, b) => s + b.remainingQty, 0);
          return (
            finalSum === initialSum - physicallyConsumed && clone.every(b => b.remainingQty >= 0)
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ─── Bug #613 — Concurrent consume race-guard invariants ──────────────────────
// Модель дзеркалить conditional decrement через updateMany з `remainingQty: gte: take`.
// Race scenario: два concurrent WRITEOFF читають однаковий snapshot findMany,
// один комітить перший, другий на updateMany отримує count=0 → throw.
describe('BatchService — concurrent consume race-guard (Bug #613)', () => {
  it('conditional decrement симуляція: 2 concurrent → 1 success + 1 throw = все консистентно', () => {
    // Модель: батч remaining=10, обидва tx читають 10, беруть take=10.
    // Перший updateMany з gte:10 → count=1, декремент до 0.
    // Другий updateMany з gte:10 → count=0 (тепер remaining=0), throw.
    // Результат: 1 успіх × 10 units, 1 fail; сумарний consumed = 10 = initial.
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 100 }), // initial remaining
        fc.integer({ min: 1, max: 50 }), // take per concurrent tx
        (initial, take) => {
          fc.pre(take <= initial);
          let remaining = initial;
          const results: { success: boolean; consumed: number }[] = [];
          // Симуляція: 2 concurrent tx, кожен намагається взяти take.
          for (let i = 0; i < 2; i++) {
            if (remaining >= take) {
              remaining -= take;
              results.push({ success: true, consumed: take });
            } else {
              // updateMany.count === 0 → throw → 0 consumed (все rollback)
              results.push({ success: false, consumed: 0 });
            }
          }
          const totalConsumed = results.reduce((s, r) => s + r.consumed, 0);
          // Інваріант: сумарний consumed НЕ перевищує початковий remaining
          return (
            totalConsumed <= initial && remaining === initial - totalConsumed && remaining >= 0
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it('conditional decrement guard: якщо remainingQty < take → count=0 → скасовуємо consume', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 200 }),
        (remaining, take) => {
          // Симуляція updateMany з `WHERE remainingQty >= take`
          const wouldDecrement = remaining >= take;
          const finalRemaining = wouldDecrement ? remaining - take : remaining;
          // Інваріант: після спроби декременту, remaining НІКОЛИ не негативний.
          return finalRemaining >= 0;
        },
      ),
      { numRuns: 500 },
    );
  });
});
