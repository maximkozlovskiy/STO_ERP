import * as fc from 'fast-check';
import { describe, it, expect } from 'vitest';

type TxType = 'CHARGE' | 'PAYMENT' | 'PREPAYMENT' | 'REFUND' | 'CREDIT_NOTE';

const BALANCE_INCREASING: TxType[] = ['CHARGE'];
const BALANCE_DECREASING: TxType[] = ['PAYMENT', 'PREPAYMENT', 'REFUND', 'CREDIT_NOTE'];

/** Кумулятивно застосовує транзакції до початкового балансу. */
function applyTransactions(
  txs: { type: TxType; amount: number }[],
  initialBalance = 0,
): number {
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
      fc.property(moneyAmount(), (amount) => {
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
      fc.property(
        fc.array(moneyAmount(), { minLength: 1, maxLength: 10 }),
        (amounts) => {
          const total = amounts.reduce((s, a) => s + a, 0);
          const txs: { type: TxType; amount: number }[] = [
            ...amounts.map((amount) => ({ type: 'CHARGE' as TxType, amount })),
            { type: 'PAYMENT', amount: total },
          ];
          const balance = applyTransactions(txs);
          return balance === 0;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('CHARGE + PAYMENT де payment >= charge → balance ≤ 0 (overpaid)', () => {
    fc.assert(
      fc.property(
        moneyAmount(),
        moneyAmount(),
        (chargeAmount, paymentAmount) => {
          fc.pre(paymentAmount >= chargeAmount);
          const balance = applyTransactions([
            { type: 'CHARGE', amount: chargeAmount },
            { type: 'PAYMENT', amount: paymentAmount },
          ]);
          return balance <= 0;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('тільки CHARGE може зробити баланс позитивним з нуля', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<TxType>('PAYMENT', 'PREPAYMENT', 'REFUND', 'CREDIT_NOTE'),
        moneyAmount(),
        (type, amount) => {
          const balance = applyTransactions([{ type, amount }], 0);
          return balance < 0;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('порядок транзакцій не впливає на фінальний баланс (комутативність)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.constantFrom<TxType>('CHARGE', 'PAYMENT', 'PREPAYMENT', 'REFUND', 'CREDIT_NOTE'),
            amount: moneyAmount(),
          }),
          { minLength: 2, maxLength: 10 },
        ),
        (txs) => {
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
      fc.property(moneyAmount(), (amount) => {
        const balanceA = applyTransactions([{ type: 'CREDIT_NOTE', amount }], 100_000);
        const balanceB = applyTransactions([{ type: 'PAYMENT', amount }], 100_000);
        return balanceA === balanceB;
      }),
      { numRuns: 200 },
    );
  });

  it('пуста послідовність транзакцій → баланс не змінюється', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000, max: 100_000 }), (initialBalance) => {
        const balance = applyTransactions([], initialBalance);
        return balance === initialBalance;
      }),
    );
  });
});
