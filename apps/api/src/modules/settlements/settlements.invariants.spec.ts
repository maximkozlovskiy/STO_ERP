import * as fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { SettlementTransactionType } from '@prisma/client';
import { BALANCE_SIGN } from './settlements.service';
import {
  SETTLEMENT_BALANCE_SIGN,
  SETTLEMENT_BALANCE_UP_TYPES,
  SETTLEMENT_TX_CHARGE_LIKE_TYPES,
} from '@sto/shared';

type TxType =
  | 'CHARGE'
  | 'PAYMENT'
  | 'PREPAYMENT'
  | 'REFUND'
  | 'CREDIT_NOTE'
  | 'SUPPLIER_CHARGE'
  | 'SUPPLIER_PAYMENT'
  | 'SUPPLIER_REFUND'
  | 'FX_GAIN'
  | 'FX_LOSS';

// Дзеркалить BALANCE_SIGN (settlements.service). Постачальницькі типи мають окрему семантику:
// SUPPLIER_CHARGE −1 (ми винні), SUPPLIER_PAYMENT/SUPPLIER_REFUND +1 (наш борг ↓).
// Курсові різниці (Фаза 4): FX_GAIN +1 (гасить від'ємний залишок), FX_LOSS −1 (гасить додатний).
const BALANCE_INCREASING: TxType[] = ['CHARGE', 'SUPPLIER_PAYMENT', 'SUPPLIER_REFUND', 'FX_GAIN'];
const BALANCE_DECREASING: TxType[] = [
  'PAYMENT',
  'PREPAYMENT',
  'REFUND',
  'CREDIT_NOTE',
  'SUPPLIER_CHARGE',
  'FX_LOSS',
];

/** Кумулятивно застосовує транзакції до початкового балансу. */
function applyTransactions(txs: { type: TxType; amount: number }[], initialBalance = 0): number {
  return txs.reduce((balance, { type, amount }) => {
    if (BALANCE_INCREASING.includes(type)) return balance + amount;
    if (BALANCE_DECREASING.includes(type)) return balance - amount;
    return balance;
  }, initialBalance);
}

describe('Settlements — balance invariants (property-based)', () => {
  // Грошові суми зберігаються в центах (integer) щоб уникнути плаваючої точки.
  // Це теж дзеркалить реальну поведінку БД (Decimal у Prisma).
  const moneyAmount = () => fc.integer({ min: 1, max: 10_000_000 }); // центи: 0.01 - 100000.00

  it('CHARGE збільшує баланс рівно на amount', () => {
    fc.assert(
      fc.property(moneyAmount(), amount => {
        const before = 0;
        const after = applyTransactions([{ type: 'CHARGE', amount }], before);
        return after === before + amount && after > before;
      }),
      { numRuns: 500 },
    );
  });

  it('PAYMENT/PREPAYMENT/REFUND/CREDIT_NOTE зменшують баланс рівно на amount', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<TxType>('PAYMENT', 'PREPAYMENT', 'REFUND', 'CREDIT_NOTE'),
        moneyAmount(),
        (type, amount) => {
          const before = 20_000_000;
          const after = applyTransactions([{ type, amount }], before);
          return after === before - amount && after < before;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('сума CHARGE = сума PAYMENT → balance = 0', () => {
    fc.assert(
      fc.property(fc.array(moneyAmount(), { minLength: 1, maxLength: 10 }), amounts => {
        const total = amounts.reduce((s, a) => s + a, 0);
        const txs: { type: TxType; amount: number }[] = [
          ...amounts.map(amount => ({ type: 'CHARGE' as TxType, amount })),
          { type: 'PAYMENT', amount: total },
        ];
        const balance = applyTransactions(txs);
        return balance === 0;
      }),
      { numRuns: 500 },
    );
  });

  it('CHARGE + PAYMENT де payment >= charge → balance ≤ 0 (overpaid)', () => {
    fc.assert(
      fc.property(moneyAmount(), moneyAmount(), (chargeAmount, paymentAmount) => {
        fc.pre(paymentAmount >= chargeAmount);
        const balance = applyTransactions([
          { type: 'CHARGE', amount: chargeAmount },
          { type: 'PAYMENT', amount: paymentAmount },
        ]);
        return balance <= 0;
      }),
      { numRuns: 300 },
    );
  });

  it('balance-decreasing типи роблять баланс від’ємним з нуля', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<TxType>(
          'PAYMENT',
          'PREPAYMENT',
          'REFUND',
          'CREDIT_NOTE',
          'SUPPLIER_CHARGE',
        ),
        moneyAmount(),
        (type, amount) => {
          const balance = applyTransactions([{ type, amount }], 0);
          return balance < 0;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('balance-increasing типи роблять баланс додатним з нуля', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<TxType>('CHARGE', 'SUPPLIER_PAYMENT', 'SUPPLIER_REFUND'),
        moneyAmount(),
        (type, amount) => {
          const balance = applyTransactions([{ type, amount }], 0);
          return balance > 0;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('постачальницький цикл SUPPLIER_CHARGE(−X) + SUPPLIER_PAYMENT(+X) → balance = 0', () => {
    fc.assert(
      fc.property(moneyAmount(), amount => {
        const balance = applyTransactions([
          { type: 'SUPPLIER_CHARGE', amount }, // отримали товар → ми винні
          { type: 'SUPPLIER_PAYMENT', amount }, // заплатили → борг погашено
        ]);
        return balance === 0;
      }),
      { numRuns: 300 },
    );
  });

  it('порядок транзакцій не впливає на фінальний баланс (комутативність)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.constantFrom<TxType>(
              'CHARGE',
              'PAYMENT',
              'PREPAYMENT',
              'REFUND',
              'CREDIT_NOTE',
            ),
            amount: moneyAmount(),
          }),
          { minLength: 2, maxLength: 10 },
        ),
        txs => {
          const balanceA = applyTransactions(txs);
          const reversed = [...txs].reverse();
          const balanceB = applyTransactions(reversed);
          return balanceA === balanceB;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('CREDIT_NOTE робить те саме що PAYMENT (зменшує баланс)', () => {
    fc.assert(
      fc.property(moneyAmount(), amount => {
        const balanceA = applyTransactions([{ type: 'CREDIT_NOTE', amount }], 100_000);
        const balanceB = applyTransactions([{ type: 'PAYMENT', amount }], 100_000);
        return balanceA === balanceB;
      }),
      { numRuns: 200 },
    );
  });

  it('пуста послідовність транзакцій → баланс не змінюється', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000, max: 100_000 }), initialBalance => {
        const balance = applyTransactions([], initialBalance);
        return balance === initialBalance;
      }),
    );
  });

  // Bug #608 regression guard: наступний refactor знаку не втратить жодне enum-значення.
  it('BALANCE_SIGN покриває ВСІ SettlementTransactionType (exhaustive) і кожен ±1', () => {
    const enumValues = Object.values(SettlementTransactionType);
    // Не менше 10 значень (CHARGE/PAYMENT/PREPAYMENT/REFUND/CREDIT_NOTE + 3 SUPPLIER_* + 2 FX_*).
    expect(enumValues.length).toBeGreaterThanOrEqual(10);
    for (const t of enumValues) {
      const sign = BALANCE_SIGN[t];
      expect(sign, `BALANCE_SIGN missing for enum value ${t}`).toBeDefined();
      expect([1, -1], `BALANCE_SIGN[${t}] must be ±1, got ${sign}`).toContain(sign);
    }
    // Явні очікування знаку по кожному типу — інвертація зловиться CI (Bug #606 root cause).
    expect(BALANCE_SIGN.CHARGE).toBe(1);
    expect(BALANCE_SIGN.PAYMENT).toBe(-1);
    expect(BALANCE_SIGN.PREPAYMENT).toBe(-1);
    expect(BALANCE_SIGN.REFUND).toBe(-1);
    expect(BALANCE_SIGN.CREDIT_NOTE).toBe(-1);
    expect(BALANCE_SIGN.SUPPLIER_CHARGE).toBe(-1);
    expect(BALANCE_SIGN.SUPPLIER_PAYMENT).toBe(1);
    expect(BALANCE_SIGN.SUPPLIER_REFUND).toBe(1);
    // Курсові різниці (Фаза 4): FX_GAIN гасить від'ємний залишок (+1), FX_LOSS — додатний (−1).
    expect(BALANCE_SIGN.FX_GAIN).toBe(1);
    expect(BALANCE_SIGN.FX_LOSS).toBe(-1);
  });

  // Bug #715 cross-layer guard: фронт (SettlementsTabContent + counterparties/[id]) споживає
  // SETTLEMENT_BALANCE_UP_TYPES з @sto/shared для знаку «+»/«−». Раніше кожен екран тримав власний
  // локальний Set → зміна бекового BALANCE_SIGN мовчки десинхронізувала б знак на UI (жоден тест
  // не ловив). Цей тест прив'язує shared-константу до бекового BALANCE_SIGN: інвертація/додавання
  // типу без синхронного оновлення shared → CI червоний ДО релізу.
  it('shared SETTLEMENT_BALANCE_SIGN дзеркалить бековий BALANCE_SIGN 1-в-1 (усі типи, кожен знак)', () => {
    const enumValues = Object.values(SettlementTransactionType);
    // Кожен enum-тип присутній у shared і має ТОЙ САМИЙ знак, що й бек.
    for (const t of enumValues) {
      expect(
        SETTLEMENT_BALANCE_SIGN[t],
        `shared SETTLEMENT_BALANCE_SIGN missing ${t}`,
      ).toBeDefined();
      expect(SETTLEMENT_BALANCE_SIGN[t], `shared sign for ${t} розходиться з беком`).toBe(
        BALANCE_SIGN[t],
      );
    }
    // Shared не має ЗАЙВИХ ключів (drift у зворотній бік — фантомний тип у UI).
    expect(Object.keys(SETTLEMENT_BALANCE_SIGN).sort()).toEqual([...enumValues].sort());
    // Похідний UP-set = рівно типи з бековим sign=+1 (те, що фронт малює знаком «+»).
    const backendUp = enumValues.filter(t => BALANCE_SIGN[t] === 1).sort();
    expect([...SETTLEMENT_BALANCE_UP_TYPES].sort()).toEqual(backendUp);
  });

  // Bug #715: колір рядка = «charge-like» бізнес-семантика (борг створено = destructive), НЕ
  // balance-sign. Обидва settlement-екрани споживають ТОЙ САМИЙ SETTLEMENT_TX_CHARGE_LIKE_TYPES →
  // жодного cross-page колір-drift. Guard фіксує навмисне розходження зі знаком (постач. типи).
  it('SETTLEMENT_TX_CHARGE_LIKE_TYPES = {CHARGE, SUPPLIER_CHARGE} — колір окремий від знаку', () => {
    expect([...SETTLEMENT_TX_CHARGE_LIKE_TYPES].sort()).toEqual(['CHARGE', 'SUPPLIER_CHARGE']);
    // SUPPLIER_CHARGE: charge-like (червоний) АЛЕ balance-sign −1 (не у UP-set) — навмисне
    // розходження кольору й знаку. Цей рядок фіксує його, щоб «спрощення» не злило їх назад.
    expect(SETTLEMENT_TX_CHARGE_LIKE_TYPES.has('SUPPLIER_CHARGE')).toBe(true);
    expect(SETTLEMENT_BALANCE_UP_TYPES.has('SUPPLIER_CHARGE')).toBe(false);
    // SUPPLIER_PAYMENT: дзеркальний випадок — sign +1 (у UP-set) АЛЕ НЕ charge-like (зелений).
    expect(SETTLEMENT_BALANCE_UP_TYPES.has('SUPPLIER_PAYMENT')).toBe(true);
    expect(SETTLEMENT_TX_CHARGE_LIKE_TYPES.has('SUPPLIER_PAYMENT')).toBe(false);
    // Курсові різниці (Фаза 4): НЕ charge-like (колір за типом у frontend: GAIN зелений/LOSS червоний,
    // не через charge-like set). FX_GAIN у UP-set (+1), FX_LOSS ні (−1).
    expect(SETTLEMENT_TX_CHARGE_LIKE_TYPES.has('FX_GAIN')).toBe(false);
    expect(SETTLEMENT_TX_CHARGE_LIKE_TYPES.has('FX_LOSS')).toBe(false);
    expect(SETTLEMENT_BALANCE_UP_TYPES.has('FX_GAIN')).toBe(true);
    expect(SETTLEMENT_BALANCE_UP_TYPES.has('FX_LOSS')).toBe(false);
  });

  it('частковий постач. цикл: receive(X) − pay(Y<X) + refund(Z) → −(X−Y−Z)', () => {
    fc.assert(
      fc.property(moneyAmount(), moneyAmount(), moneyAmount(), (received, paid, refunded) => {
        // Пропускаємо надлишкові плати/повернення (реальний BUG-scenario 1: часткова оплата <X)
        fc.pre(paid <= received);
        fc.pre(refunded <= received - paid);
        const balance = applyTransactions([
          { type: 'SUPPLIER_CHARGE', amount: received },
          { type: 'SUPPLIER_PAYMENT', amount: paid },
          { type: 'SUPPLIER_REFUND', amount: refunded },
        ]);
        return balance === -(received - paid - refunded);
      }),
      { numRuns: 500 },
    );
  });

  it('змішаний BOTH-контрагент: CLIENT CHARGE + SUPPLIER_CHARGE, знаки НЕ інтерферують', () => {
    fc.assert(
      fc.property(moneyAmount(), moneyAmount(), (clientDebt, supplierDebt) => {
        // BOTH-контрагент: WO нарахування (+) і PO receive (−).
        // Результат = clientDebt − supplierDebt (алгебраїчна сума знаку).
        const balance = applyTransactions([
          { type: 'CHARGE', amount: clientDebt }, // клієнт нам винен: +
          { type: 'SUPPLIER_CHARGE', amount: supplierDebt }, // ми винні постачальнику: −
        ]);
        return balance === clientDebt - supplierDebt;
      }),
      { numRuns: 300 },
    );
  });

  // Payables FX (Фаза 5) — ЯДЕРНИЙ інваріант постачальницького боку: знак ІНВЕРТОВАНИЙ відносно
  // клієнта (SUPPLIER_CHARGE=−1, SUPPLIER_PAYMENT=+1). Залишок = paidBase−chargeBase; FX обнуляє.
  // fx=chargeBase−paidBase; fx>0→FX_GAIN(+1), fx<0→FX_LOSS(−1). Хибний (клієнтський) знак подвоїв би.
  it('FX zeroing (payables): SUPPLIER_CHARGE(cb) + SUPPLIER_PAYMENT(pb) + FX → balance 0 (обидва напрями)', () => {
    fc.assert(
      fc.property(moneyAmount(), moneyAmount(), (chargeBase, paidBase) => {
        const fx = chargeBase - paidBase;
        // ІНВЕРСІЯ клієнта: fx>0 → FX_GAIN (не FX_LOSS!), fx<0 → FX_LOSS.
        const fxType: TxType = fx > 0 ? 'FX_GAIN' : 'FX_LOSS';
        const balance = applyTransactions([
          { type: 'SUPPLIER_CHARGE', amount: chargeBase }, // −1
          { type: 'SUPPLIER_PAYMENT', amount: paidBase }, // +1
          { type: fxType, amount: Math.abs(fx) },
        ]);
        return balance === 0;
      }),
      { numRuns: 500 },
    );
  });

  // Курсові різниці (Фаза 4) — ЯДЕРНИЙ інваріант: повна оплата іновалютного рахунку у base НЕ
  // зводиться до нуля (курс нарахування ≠ курс оплати); FX-проводка обнуляє залишок ТОЧНО.
  // chargeBase + (−paidBase) + FX = 0, де FX = −(chargeBase − paidBase). Хибний знак FX подвоїв би
  // залишок замість обнулення — цей тест ловить інверсію.
  it('FX zeroing: CHARGE(cb) + PAYMENT(pb) + FX(cb−pb) → balance == 0 (обидва напрями)', () => {
    fc.assert(
      fc.property(moneyAmount(), moneyAmount(), (chargeBase, paidBase) => {
        const fx = chargeBase - paidBase;
        // fx>0 → нарахували більше base ніж отримали → FX_LOSS(−1) гасить додатний залишок.
        // fx<0 → отримали більше → FX_GAIN(+1) гасить від'ємний. |fx| завжди додатна сума проводки.
        const fxType: TxType = fx > 0 ? 'FX_LOSS' : 'FX_GAIN';
        const balance = applyTransactions([
          { type: 'CHARGE', amount: chargeBase },
          { type: 'PAYMENT', amount: paidBase },
          { type: fxType, amount: Math.abs(fx) },
        ]);
        return balance === 0;
      }),
      { numRuns: 500 },
    );
  });

  // Курсові різниці (Фаза 4) — DUST-інваріант (scenario #9): кілька ЧАСТКОВИХ оплат, кожна з
  // amountBase округленою до копійки (Decimal(12,2) — convertToBase→roundMoney), сумуються у paidBase.
  // Оскільки chargeBase і КОЖНА paidBase_i вже кратні 0.01, fx=roundMoney(cb−Σpb)=cb−Σpb ТОЧНО
  // (roundMoney no-op) → FX обнуляє base-залишок без копійчаного залишку. Тест моделює центи (integer)
  // → кратність 0.01 гарантована; перевіряє що будь-яка кількість часткових + FX = рівно 0.
  it('FX dust: N часткових оплат (округлені центи) + FX → balance == 0 ТОЧНО (без копійок)', () => {
    fc.assert(
      fc.property(
        moneyAmount(),
        fc.array(moneyAmount(), { minLength: 1, maxLength: 12 }),
        (chargeBase, partials) => {
          const paidBase = partials.reduce((s, p) => s + p, 0);
          const fx = chargeBase - paidBase;
          const fxType: TxType = fx > 0 ? 'FX_LOSS' : 'FX_GAIN';
          const txs: { type: TxType; amount: number }[] = [
            { type: 'CHARGE', amount: chargeBase },
            ...partials.map(p => ({ type: 'PAYMENT' as TxType, amount: p })),
          ];
          if (fx !== 0) txs.push({ type: fxType, amount: Math.abs(fx) });
          // Integer-центи → жодного float-дрейфу; residual МУСИТЬ бути рівно 0.
          return applyTransactions(txs) === 0;
        },
      ),
      { numRuns: 500 },
    );
  });
});
