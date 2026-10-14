/**
 * Бонуси за сторновану оплату (BR-CASH-024):
 *
 *   • `reverseEarn` списує бали, нараховані САМЕ за цю оплату (EARN з її `documentId`);
 *   • не нижче нуля: те, що клієнт уже витратив, не забираємо, і це не помилка;
 *   • повтор не списує вдруге;
 *   • `earn` для сторнованої оплати не нараховує — нарахування асинхронне (черга) і може прийти
 *     ПІСЛЯ сторно.
 *
 * Написано зі специфікації ДО коду. Контракт (план 2026-10-14):
 *   LoyaltyService.reverseEarn(orgId, paymentId, tx?)
 *   LoyaltyService.earn(orgId, counterpartyId, paymentAmount, documentId?) — наявний.
 *
 * Рахунок, леджер, оплата й налаштування — таблиці в пам'яті (`memoryTable`): `where`, `increment`,
 * `decrement`, `gte` вони виконують по-справжньому. Леджер бачить рахунок через зв'язок `account`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { LoyaltyService } from './loyalty.service';
import { memoryTable, type MemRow } from '../cash/cash.spec-fixture';
import type { PrismaService } from '../../prisma/prisma.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const CLIENT = 'c0000001-0000-4000-8000-000000000001';
const ACC = 'a0000001-0000-4000-8000-000000000001';
const PAY = 'b0000001-0000-4000-8000-000000000001';
const PAY_2 = 'b0000002-0000-4000-8000-000000000002';

interface Seed {
  balance?: number;
  /** Бали, нараховані за PAY (null — нарахування не було). */
  earnedForPay?: number | null;
  /** Бали, нараховані за ІНШУ оплату того самого клієнта. */
  earnedForOther?: number | null;
  paymentReversed?: boolean;
}

function makeHarness(seed: Seed = {}) {
  const account: MemRow = {
    id: ACC,
    orgId: ORG,
    counterpartyId: CLIENT,
    balance: seed.balance ?? 50,
  };
  const accounts = memoryTable([account]);
  const ledger: MemRow[] = [];
  const earn = (id: string, points: number, documentId: string): MemRow => ({
    id,
    accountId: ACC,
    type: 'EARN',
    points,
    documentId,
    documentType: 'Payment',
    notes: null,
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
  });
  if (seed.earnedForPay !== null) ledger.push(earn('lt-1', seed.earnedForPay ?? 12, PAY));
  if (seed.earnedForOther != null) ledger.push(earn('lt-2', seed.earnedForOther, PAY_2));

  const tables = {
    loyaltyAccount: accounts,
    loyaltyTransaction: memoryTable(ledger, () => ({ createdAt: new Date() }), {
      account: row => accounts.rows.find(a => a.id === row.accountId),
    }),
    payment: memoryTable([
      {
        id: PAY,
        orgId: ORG,
        counterpartyId: CLIENT,
        amount: 1200,
        reversedAt: seed.paymentReversed ? new Date('2026-10-14T09:00:00.000Z') : null,
      },
    ]),
    organisationSettings: memoryTable([
      { id: 'set-1', orgId: ORG, loyaltyEnabled: true, loyaltyEarnPer: 100, loyaltyEarnPoints: 1 },
    ]),
    counterparty: memoryTable([{ id: CLIENT, orgId: ORG, deletedAt: null }]),
  };
  const prisma = {
    ...tables,
    $transaction: vi.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (c: unknown) => Promise<unknown>)(prisma)
        : Promise.all(arg as Promise<unknown>[]),
    ),
  };
  const queue = { add: vi.fn() };
  const service = new LoyaltyService(prisma as unknown as PrismaService, queue as unknown as Queue);
  const balance = (): number => Number(account.balance);
  return { service, prisma, tables, account, ledger, balance };
}

describe('LoyaltyService.reverseEarn — списання бонусів за сторновану оплату', () => {
  // guards: BR-CASH-024
  it('нараховано 12 за оплату, на рахунку 50 → 38', async () => {
    const h = makeHarness({ balance: 50, earnedForPay: 12 });
    await h.service.reverseEarn(ORG, PAY);
    expect(h.balance()).toBe(38);
  });

  // guards: BR-CASH-024
  it('списує лише нараховане за ЦЮ оплату, а не за інші оплати клієнта', async () => {
    const h = makeHarness({ balance: 50, earnedForPay: 12, earnedForOther: 30 });
    await h.service.reverseEarn(ORG, PAY);
    expect(h.balance()).toBe(38);
  });

  // guards: BR-CASH-024
  it('дробові бали (2 знаки) — без float-пилу: 10.35 нараховано, 20.1 на рахунку → 9.75', async () => {
    const h = makeHarness({ balance: 20.1, earnedForPay: 10.35 });
    await h.service.reverseEarn(ORG, PAY);
    expect(h.balance()).toBeCloseTo(9.75, 2);
  });

  // Клієнт уже витратив частину балів — забрати їх нема звідки, і сторно через це не падає.
  // guards: BR-CASH-024
  it('на рахунку менше, ніж нараховано (5 із 12) → 0, без помилки', async () => {
    const h = makeHarness({ balance: 5, earnedForPay: 12 });
    await h.service.reverseEarn(ORG, PAY);
    expect(h.balance()).toBe(0);
  });

  // guards: BR-CASH-024
  it('на рахунку 0 → лишається 0, без помилки', async () => {
    const h = makeHarness({ balance: 0, earnedForPay: 12 });
    await h.service.reverseEarn(ORG, PAY);
    expect(h.balance()).toBe(0);
  });

  // guards: BR-CASH-024
  it('повтор не списує вдруге: 50 → 38 → 38', async () => {
    const h = makeHarness({ balance: 50, earnedForPay: 12 });
    await h.service.reverseEarn(ORG, PAY);
    await h.service.reverseEarn(ORG, PAY);
    expect(h.balance()).toBe(38);
  });

  // Джоб нарахування ще не відпрацював (або програма вимкнена) — списувати нічого.
  // guards: BR-CASH-024
  it('за оплату нічого не нараховано → рахунок не змінюється, без помилки', async () => {
    const h = makeHarness({ balance: 50, earnedForPay: null, earnedForOther: 30 });
    await h.service.reverseEarn(ORG, PAY);
    expect(h.balance()).toBe(50);
  });

  // guards: BR-CASH-024
  it('чужа організація не списує бонусів цієї', async () => {
    const h = makeHarness({ balance: 50, earnedForPay: 12 });
    await h.service.reverseEarn(OTHER_ORG, PAY).catch(() => undefined);
    expect(h.balance()).toBe(50);
  });

  // Списання — частина транзакції сторно: якщо каса відкотиться, бали мусять повернутись разом.
  // guards: BR-CASH-024
  it('переданий tx → запис іде через нього, а не через кореневий клієнт', async () => {
    const h = makeHarness({ balance: 50, earnedForPay: 12 });
    const forbid = (m: string) => () => {
      throw new Error(`reverseEarn із tx пише через this.prisma.${m}`);
    };
    const tx = { ...h.tables };
    for (const name of Object.keys(h.tables) as (keyof typeof h.tables)[]) {
      h.prisma[name] = {
        ...h.tables[name],
        create: vi.fn(forbid(name)),
        update: vi.fn(forbid(name)),
        updateMany: vi.fn(forbid(name)),
        upsert: vi.fn(forbid(name)),
      } as never;
    }
    await h.service.reverseEarn(ORG, PAY, tx as never);
    expect(h.balance()).toBe(38);
  });
});

describe('LoyaltyService.earn — сторнована оплата бонусів не дає', () => {
  // Контроль harness: звичайна оплата 1200 при «1 бал за 100» дає 12.
  // guards: BR-CASH-024
  it('несторнована оплата 1200 → +12 (контроль)', async () => {
    const h = makeHarness({ balance: 0, earnedForPay: null });
    await h.service.earn(ORG, CLIENT, 1200, PAY);
    expect(h.balance()).toBe(12);
  });

  // Нарахування асинхронне: джоб із черги може прийти ПІСЛЯ сторно.
  // guards: BR-CASH-024
  it('оплату сторновано до відпрацювання джобу → нічого не нараховано, леджер без EARN', async () => {
    const h = makeHarness({ balance: 0, earnedForPay: null, paymentReversed: true });
    await h.service.earn(ORG, CLIENT, 1200, PAY);
    expect(h.balance()).toBe(0);
    expect(h.ledger.filter(r => r.type === 'EARN' && r.documentId === PAY)).toEqual([]);
  });
});
