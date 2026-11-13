import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';
import { createPgAdapter } from '../../prisma/pg-adapter';
import { handleDbUnavailable, testDatabaseUrl } from '../../common/testing/require-db';

/**
 * ІНТЕГРАЦІЙНИЙ спек проти ЖИВОЇ dev-БД: міграція компенсації хибних курсових різниць передоплати
 * (BR-SUPPAY-019, TECH-DEBT (б) №91 б) — `20261113120000_compensate_prepaid_supplier_fx`.
 *
 * SQL міграції виконується в транзакції над зібраними тут замовленнями, і транзакція ВІДКОЧУЄТЬСЯ:
 * у dev-базі не лишається ні постачальників, ні замовлень, ні проводок (журнал append-only — інакше
 * прибрати його було б нічим). Перевіряється справжній SQL, а не його переказ:
 *
 *   A. Передоплачене, не прийняте («Замовлено», `paidAt`), хибна FX_LOSS на всю оплату без відкату →
 *      одна FX_GAIN на ту саму суму; баланс постачальника = аванс (оплата − нараховано).
 *   B. Хибну FX уже відкотило сторно (FX_LOSS + FX_GAIN, чиста 0), замовлення скасоване → не чіпається.
 *   C. Прийняте ПІСЛЯ хибної FX і сплачене («Отримано», `paidAt`) → чиста FX = нараховано − сплачено
 *      (BR-SUPPAY-018), баланс постачальника 0.
 *   D. Правильна FX (після останнього нарахування) — не уражене, не чіпається.
 *   Повторний запуск того самого SQL нічого не пише.
 *
 * Умови запуску: жива dev-Postgres на DATABASE_URL із застосованими міграціями й seed (організація,
 * склад, валюта). Без БД — SKIP (у CI з REQUIRE_DB=1 — падіння).
 */

const DATABASE_URL = testDatabaseUrl();
const MARKER = `000 TST fxcomp ${Date.now()}`;
const MIGRATION_SQL = readFileSync(
  join(
    __dirname,
    '../../../../../packages/database/prisma/migrations',
    '20261113120000_compensate_prepaid_supplier_fx/migration.sql',
  ),
  'utf-8',
);
const FOLLOW_UP_SQL = readFileSync(
  join(
    __dirname,
    '../../../../../packages/database/prisma/migrations',
    '20261113140000_compensate_unreceived_supplier_fx/migration.sql',
  ),
  'utf-8',
);
const NOTE = 'Компенсація хибної курсової різниці передоплати (Bug #1054)';

let dbAvailable = false;
let raw: PrismaClient;
let orgId: string;
let warehouseId: string;
let currencyId: string;

class Rollback extends Error {}

beforeAll(async () => {
  raw = new PrismaClient({ adapter: createPgAdapter(DATABASE_URL) });
  try {
    await raw.$connect();
    await raw.$queryRawUnsafe(`SELECT 1 FROM "settlement_transactions" LIMIT 0`);
  } catch {
    handleDbUnavailable('підключення недоступне або міграції не застосовані');
    return;
  }
  const warehouse = await raw.warehouse.findFirst({
    where: { deletedAt: null },
    select: { id: true, orgId: true },
  });
  if (!warehouse) throw new Error('seed: немає складу');
  orgId = warehouse.orgId;
  warehouseId = warehouse.id;
  const currency = await raw.currency.findFirst({
    where: { orgId, deletedAt: null },
    select: { id: true },
  });
  if (!currency) throw new Error('seed: немає валюти');
  currencyId = currency.id;
  dbAvailable = true;
}, 30_000);

afterAll(async () => {
  if (raw) await raw.$disconnect().catch(() => undefined);
});

type Tx = Prisma.TransactionClient;
type Posting = { type: string; amount: number; at: string; payment?: boolean };

/**
 * Постачальник із рахунком розрахунків, замовлення, проведена оплата на нього (якщо є оплата в
 * журналі) і проводки з заданим часом. Баланс рахунку — Σ знак × сума (як веде SettlementsService).
 */
async function seedOrder(
  tx: Tx,
  label: string,
  po: { status: 'ORDERED' | 'PARTIAL' | 'RECEIVED' | 'CANCELLED'; paid: boolean },
  postings: Posting[],
) {
  const sign: Record<string, number> = {
    SUPPLIER_CHARGE: -1,
    SUPPLIER_PAYMENT: 1,
    FX_GAIN: 1,
    FX_LOSS: -1,
  };
  const supplier = await tx.counterparty.create({
    data: { orgId, type: 'SUPPLIER', companyName: `${MARKER} ${label}` },
    select: { id: true },
  });
  const balance = postings.reduce((acc, p) => acc + sign[p.type]! * p.amount, 0);
  const account = await tx.settlementAccount.create({
    data: { orgId, counterpartyId: supplier.id, balance },
    select: { id: true },
  });
  const order = await tx.purchaseOrder.create({
    data: {
      orgId,
      supplierId: supplier.id,
      warehouseId,
      currencyId,
      number: `${MARKER} ${label}`,
      status: po.status,
      totalAmount: 100,
      paidAmount: po.paid ? 100 : 0,
      paidAt: po.paid ? new Date('2026-01-10T00:00:00.000Z') : null,
    },
    select: { id: true },
  });
  for (const p of postings) {
    let documentType = 'PurchaseOrder';
    let documentId = order.id;
    if (p.payment) {
      const sp = await tx.supplierPayment.create({
        data: {
          orgId,
          supplierId: supplier.id,
          purchaseOrderId: order.id,
          sourceType: 'BANK_ACCOUNT',
          number: `${MARKER} ${label} оплата`,
          status: 'CONFIRMED',
          amount: 100,
          currencyId,
          method: 'bank_transfer',
        },
        select: { id: true },
      });
      documentType = 'SupplierPayment';
      documentId = sp.id;
    }
    await tx.settlementTransaction.create({
      data: {
        orgId,
        settlementAccountId: account.id,
        type: p.type as Prisma.SettlementTransactionCreateManyInput['type'],
        amount: p.amount,
        amountBase: p.amount,
        rateUsed: 1,
        documentType,
        documentId,
        createdAt: new Date(p.at),
      },
    });
  }
  return { poId: order.id, accountId: account.id };
}

async function stateOf(tx: Tx, o: { poId: string; accountId: string }) {
  const [fx, account] = await Promise.all([
    tx.settlementTransaction.findMany({
      where: {
        orgId,
        documentType: 'PurchaseOrder',
        documentId: o.poId,
        type: { in: ['FX_GAIN', 'FX_LOSS'] },
      },
      select: {
        type: true,
        amountBase: true,
        notes: true,
        currencyId: true,
        settlementAccountId: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    tx.settlementAccount.findUniqueOrThrow({
      where: { id: o.accountId },
      select: { balance: true },
    }),
  ]);
  const net = fx.reduce(
    (acc, r) => acc + (r.type === 'FX_GAIN' ? 1 : -1) * Number(r.amountBase),
    0,
  );
  return {
    compensations: fx
      .filter(r => r.notes === NOTE)
      .map(r => ({
        type: r.type,
        amount: Number(r.amountBase),
        currencyId: r.currencyId,
        sameAccount: r.settlementAccountId === o.accountId,
      })),
    net: Math.round(net * 100) / 100,
    balance: Number(account.balance),
  };
}

describe('Міграція компенсації хибних FX передоплати (BR-SUPPAY-019) — жива БД, з відкатом', () => {
  // guards: BR-SUPPAY-019, BR-SUPPAY-018
  it('хибна FX без відкату компенсована, відкочена й правильна — ні; повтор нічого не пише', async ctx => {
    if (!dbAvailable) return ctx.skip();
    let result: Record<string, unknown> = {};

    await expect(
      raw.$transaction(
        async tx => {
          const a = await seedOrder(tx, 'A', { status: 'ORDERED', paid: true }, [
            { type: 'SUPPLIER_PAYMENT', amount: 4100, at: '2026-01-10T10:00:00Z', payment: true },
            { type: 'FX_LOSS', amount: 4100, at: '2026-01-10T10:00:01Z' },
          ]);
          const b = await seedOrder(tx, 'B', { status: 'CANCELLED', paid: false }, [
            { type: 'FX_LOSS', amount: 100, at: '2026-01-10T10:00:01Z' },
            { type: 'FX_GAIN', amount: 100, at: '2026-01-11T10:00:00Z' },
          ]);
          const c = await seedOrder(tx, 'C', { status: 'RECEIVED', paid: true }, [
            { type: 'SUPPLIER_PAYMENT', amount: 4100, at: '2026-01-10T10:00:00Z', payment: true },
            { type: 'FX_LOSS', amount: 4100, at: '2026-01-10T10:00:01Z' },
            { type: 'SUPPLIER_CHARGE', amount: 4200, at: '2026-01-12T10:00:00Z' },
          ]);
          const d = await seedOrder(tx, 'D', { status: 'RECEIVED', paid: true }, [
            { type: 'SUPPLIER_CHARGE', amount: 4200, at: '2026-01-12T10:00:00Z' },
            { type: 'SUPPLIER_PAYMENT', amount: 4100, at: '2026-01-13T10:00:00Z', payment: true },
            { type: 'FX_GAIN', amount: 100, at: '2026-01-13T10:00:01Z' },
          ]);

          await tx.$executeRawUnsafe(MIGRATION_SQL);
          const first = {
            a: await stateOf(tx, a),
            b: await stateOf(tx, b),
            c: await stateOf(tx, c),
            d: await stateOf(tx, d),
          };
          await tx.$executeRawUnsafe(MIGRATION_SQL);
          const second = {
            a: await stateOf(tx, a),
            b: await stateOf(tx, b),
            c: await stateOf(tx, c),
            d: await stateOf(tx, d),
          };
          result = { first, second };
          throw new Rollback('відкат');
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(Rollback);

    const { first, second } = result as Record<
      string,
      Record<string, Awaited<ReturnType<typeof stateOf>>>
    >;
    // A: хибну FX_LOSS 4100 погашено — на рахунку аванс 4100 (оплата без нарахування).
    expect(first.a).toEqual({
      compensations: [{ type: 'FX_GAIN', amount: 4100, currencyId: null, sameAccount: true }],
      net: 0,
      balance: 4100,
    });
    // B: уже відкочено (чиста 0 = цільова для скасованого) — не чіпається.
    expect(first.b).toEqual({ compensations: [], net: 0, balance: 0 });
    // C: чиста FX = нараховано − сплачено = 4200 − 4100 = 100; борг закрито.
    expect(first.c).toEqual({
      compensations: [{ type: 'FX_GAIN', amount: 4200, currencyId: null, sameAccount: true }],
      net: 100,
      balance: 0,
    });
    // D: FX після останнього нарахування — правильна, не уражене.
    expect(first.d).toEqual({ compensations: [], net: 100, balance: 0 });
    // Повторний запуск — без змін.
    expect(second).toEqual(first);
    // Відкат: у dev-базі нічого не лишилось.
    expect(
      await raw.counterparty.count({ where: { orgId, companyName: { startsWith: MARKER } } }),
    ).toBe(0);
  }, 90_000);

  // Bug #1062: «Частково» прийняте й ПОТІМ повністю сплачене — хибна FX пізніша за останнє нарахування,
  // і перша міграція її не бачить; прийом у «Отримано» вважав би її «уже визнаною». Доповнення
  // `20261113140000_compensate_unreceived_supplier_fx` зводить чисту FX не прийнятого замовлення до 0.
  // Mutation-verify: прибрати умову `status <> 'RECEIVED'` у доповненні → правильна FX «Отримано» (D)
  // теж обнуляється, кейс червоний.
  // guards: BR-SUPPAY-019
  it('«Частково» з хибною FX після нарахування: доповнення зводить FX до 0, «Отримано» не чіпає', async ctx => {
    if (!dbAvailable) return ctx.skip();
    let result: Record<string, unknown> = {};

    await expect(
      raw.$transaction(
        async tx => {
          const e = await seedOrder(tx, 'E', { status: 'PARTIAL', paid: true }, [
            { type: 'SUPPLIER_CHARGE', amount: 2100, at: '2026-01-09T10:00:00Z' },
            { type: 'SUPPLIER_PAYMENT', amount: 4100, at: '2026-01-10T10:00:00Z', payment: true },
            { type: 'FX_LOSS', amount: 2000, at: '2026-01-10T10:00:01Z' },
          ]);
          const d = await seedOrder(tx, 'D2', { status: 'RECEIVED', paid: true }, [
            { type: 'SUPPLIER_CHARGE', amount: 4200, at: '2026-01-12T10:00:00Z' },
            { type: 'SUPPLIER_PAYMENT', amount: 4100, at: '2026-01-13T10:00:00Z', payment: true },
            { type: 'FX_GAIN', amount: 100, at: '2026-01-13T10:00:01Z' },
          ]);

          await tx.$executeRawUnsafe(MIGRATION_SQL);
          const afterFirst = await stateOf(tx, e);
          await tx.$executeRawUnsafe(FOLLOW_UP_SQL);
          const afterFollowUp = { e: await stateOf(tx, e), d: await stateOf(tx, d) };
          await tx.$executeRawUnsafe(FOLLOW_UP_SQL);
          const again = { e: await stateOf(tx, e), d: await stateOf(tx, d) };
          result = { afterFirst, afterFollowUp, again };
          throw new Rollback('відкат');
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(Rollback);

    const { afterFirst, afterFollowUp, again } = result as {
      afterFirst: Awaited<ReturnType<typeof stateOf>>;
      afterFollowUp: Record<string, Awaited<ReturnType<typeof stateOf>>>;
      again: Record<string, Awaited<ReturnType<typeof stateOf>>>;
    };
    // Перша міграція «Частково» не бачить: FX_LOSS 2000 лишається, аванс з'їдено.
    expect(afterFirst).toEqual({ compensations: [], net: -2000, balance: 0 });
    // Доповнення: FX_GAIN 2000 — на рахунку аванс 2000 (сплачено 4100 − нараховано 2100).
    expect(afterFollowUp.e).toEqual({
      compensations: [{ type: 'FX_GAIN', amount: 2000, currencyId: null, sameAccount: true }],
      net: 0,
      balance: 2000,
    });
    // «Отримано» з правильною FX — не чіпається.
    expect(afterFollowUp.d).toEqual({ compensations: [], net: 100, balance: 0 });
    // Повторний запуск — без змін.
    expect(again).toEqual(afterFollowUp);
  }, 90_000);
});
