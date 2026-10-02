import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PurchaseOrderImportAdapter, type ImportLineInput } from './document-line-import.adapter';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SettingsService } from '../settings/settings.service';
import type { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { handleDbUnavailable } from '../../common/testing/require-db';

/**
 * ІНТЕГРАЦІЙНИЙ тест appendLines/replaceLines PurchaseOrderImportAdapter проти ЖИВОЇ dev-БД.
 *
 * Чому саме тут (а не в unit-spec):
 *  - a78dc80d переписав перерахунок тоталів append з findMany+reduce на СИРУ SQL-агрегацію
 *    (tx.$queryRaw SUM по purchase_order_lines). Unit-тести мокають $queryRaw — сам SQL
 *    (ідентифікатори колонок, COALESCE, фільтри orgId + deletedAt) по-справжньому НЕ перевірений.
 *    Це єдине реальне покриття цього SQL.
 *  - Фінансова логіка append (пункт 3 tester-завдання): totalAmount у БД мусить == Σ(quantity*price)
 *    по ВСІХ активних рядках, totalVat узгоджений, totalAmountBase = total*rate.
 *  - Scale: 1000 наявних + 1000 нових рядків перетинають MAX_QUERY_LIMIT=1000 — SQL-агрегація НЕ
 *    має зрізати суму (на відміну від findMany+take, що було б тихим недоліком суми).
 *
 * settings/exchangeRates — детерміновані стаби (VAT EXCLUSIVE 20%, курс 1.0): ціль тесту — саме
 * запис рядків і SQL-перерахунок у БД, а не політика ПДВ/валют (вони мають власне покриття).
 *
 * Умови запуску: жива dev-Postgres на DATABASE_URL. Без БД / без seed org — SKIP.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://sto:sto_dev_secret@localhost:5432/sto_erp';

let dbAvailable = false;
let raw: PrismaClient;
let adapter: PurchaseOrderImportAdapter;
let orgId: string;
let warehouseId: string;
let currencyId: string;
let supplierId: string;
let goodIds: string[] = [];

const createdPoIds: string[] = [];

// Детерміновані стаби: EXCLUSIVE 20% ПДВ, курс 1.0 (total == totalAmountBase).
const settingsStub = {
  getDefaultVatRate: async () => ({ vatMode: 'EXCLUSIVE' as const, vatRate: 20 }),
} as unknown as SettingsService;
const exchangeStub = {
  resolveBaseConversion: async (
    _orgId: string,
    _currencyId: string,
    _date: Date,
    amount: number,
  ) => ({ amountBase: amount, rateUsed: 1 }),
} as unknown as ExchangeRatesService;

async function cleanupPo(poId: string) {
  await raw
    .$executeRawUnsafe(`DELETE FROM purchase_order_lines WHERE "purchaseOrderId" = $1::uuid`, poId)
    .catch(() => undefined);
  await raw
    .$executeRawUnsafe(`DELETE FROM purchase_orders WHERE id = $1::uuid`, poId)
    .catch(() => undefined);
}

async function createDraftPo(): Promise<string> {
  const id = randomUUID();
  const number = `TEST-IMP-${id.slice(0, 8)}`;
  // Raw insert — уникаємо checked/unchecked relation-input тонкощів Prisma.create.
  await raw.$executeRawUnsafe(
    `INSERT INTO purchase_orders
      (id, "orgId", "warehouseId", "supplierId", number, status, "currencyId",
       "documentDate", "totalAmount", "totalVat", "paidAmount", "syncVersion", "createdAt", "updatedAt")
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'DRAFT', $6::uuid,
       NOW(), 0, 0, 0, 1, NOW(), NOW())`,
    id,
    orgId,
    warehouseId,
    supplierId,
    number,
    currencyId,
  );
  createdPoIds.push(id);
  return id;
}

/** Незалежна перевірка тоталів у БД (не через код адаптера). */
async function dbTotals(poId: string): Promise<{
  lineCount: number;
  sumQtyPrice: number;
  sumVat: number;
  poTotalAmount: number;
  poTotalVat: number;
  poTotalBase: number | null;
}> {
  const lines = await raw.purchaseOrderLine.findMany({
    where: { purchaseOrderId: poId, deletedAt: null },
    select: { quantity: true, price: true, vatAmount: true },
  });
  const po = await raw.purchaseOrder.findUniqueOrThrow({
    where: { id: poId },
    select: { totalAmount: true, totalVat: true, totalAmountBase: true },
  });
  const sumQtyPrice = lines.reduce((s, l) => s + Number(l.quantity) * Number(l.price), 0);
  const sumVat = lines.reduce((s, l) => s + Number(l.vatAmount), 0);
  return {
    lineCount: lines.length,
    sumQtyPrice: Math.round(sumQtyPrice * 100) / 100,
    sumVat: Math.round(sumVat * 100) / 100,
    poTotalAmount: Number(po.totalAmount),
    poTotalVat: Number(po.totalVat),
    poTotalBase: po.totalAmountBase == null ? null : Number(po.totalAmountBase),
  };
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  raw = new PrismaClient({ datasourceUrl: DATABASE_URL });
  try {
    await raw.$connect();
    const branch = await raw.garageBranch.findFirst({ select: { orgId: true } });
    if (!branch) {
      dbAvailable = false;
      handleDbUnavailable('підключення або seed недоступні');
      return;
    }
    orgId = branch.orgId;
    const wh = await raw.warehouse.findFirst({ where: { orgId }, select: { id: true } });
    const cur = await raw.currency.findFirst({ where: { orgId }, select: { id: true } });
    const goods = await raw.good.findMany({
      where: { orgId, deletedAt: null },
      select: { id: true },
      take: 6,
    });
    const supplier = await raw.counterparty.findFirst({
      where: { orgId, deletedAt: null },
      select: { id: true },
    });
    if (!cur || !supplier || !wh || goods.length < 5) {
      dbAvailable = false;
      handleDbUnavailable('підключення або seed недоступні');
      return;
    }
    currencyId = cur.id;
    supplierId = supplier.id;
    warehouseId = wh.id;
    goodIds = goods.map(g => g.id);
    // Адаптер працює з реальним PrismaService (raw-клієнт достатній: методи ті самі).
    adapter = new PurchaseOrderImportAdapter(
      raw as unknown as PrismaService,
      settingsStub,
      exchangeStub,
    );
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    handleDbUnavailable('підключення або seed недоступні');
  }
}, 30_000);

afterEach(async () => {
  if (!dbAvailable) return;
  while (createdPoIds.length) {
    const id = createdPoIds.pop()!;
    await cleanupPo(id);
  }
});

afterAll(async () => {
  if (raw) await raw.$disconnect();
});

describe('PurchaseOrderImportAdapter — live DB', () => {
  it('skips cleanly when no DB/seed', () => {
    if (!dbAvailable) {
      expect(true).toBe(true);
    }
  });

  it('append: 2 наявних + 2 нових → 4 рядки, totalAmount = Σ усіх, totalVat/base узгоджені (пункт 3)', async () => {
    if (!dbAvailable) return;
    const poId = await createDraftPo();

    // Початкові 2 позиції через replaceLines (канонічний шлях створення).
    const initial: ImportLineInput[] = [
      { goodId: goodIds[0]!, quantity: 2, price: 100 }, // 200
      { goodId: goodIds[1]!, quantity: 3, price: 50 }, // 150
    ];
    await raw.$transaction(async tx => adapter.replaceLines(tx, orgId, poId, initial));
    let t = await dbTotals(poId);
    expect(t.lineCount).toBe(2);
    expect(t.poTotalAmount).toBeCloseTo(350, 2);

    // Append ще 2 НОВИХ товари.
    const more: ImportLineInput[] = [
      { goodId: goodIds[2]!, quantity: 1, price: 999.99 }, // 999.99
      { goodId: goodIds[3]!, quantity: 4, price: 25 }, // 100
    ];
    await raw.$transaction(async tx => adapter.appendLines(tx, orgId, poId, more));

    t = await dbTotals(poId);
    expect(t.lineCount).toBe(4); // наявні НЕ зникли
    // totalAmount у БД == незалежна Σ(quantity*price) по ВСІХ 4 рядках
    expect(t.poTotalAmount).toBeCloseTo(t.sumQtyPrice, 2);
    expect(t.poTotalAmount).toBeCloseTo(350 + 999.99 + 100, 2); // 1449.99
    // totalVat == Σ vatAmount рядків; EXCLUSIVE 20% → ~20% від total
    expect(t.poTotalVat).toBeCloseTo(t.sumVat, 2);
    expect(t.poTotalVat).toBeCloseTo(289.998, 1);
    // курс 1.0 → base == total
    expect(t.poTotalBase).not.toBeNull();
    expect(t.poTotalBase!).toBeCloseTo(t.poTotalAmount, 2);
  });

  it('append з дублікатом goodId → ЗЛИТТЯ (кількість додається, ціна нова), не другий рядок (пункт 4)', async () => {
    if (!dbAvailable) return;
    const poId = await createDraftPo();
    await raw.$transaction(async tx =>
      adapter.replaceLines(tx, orgId, poId, [{ goodId: goodIds[0]!, quantity: 2, price: 100 }]),
    );

    // Імпортуємо той самий товар знову: qty 3 @ price 120.
    await raw.$transaction(async tx =>
      adapter.appendLines(tx, orgId, poId, [{ goodId: goodIds[0]!, quantity: 3, price: 120 }]),
    );

    const lines = await raw.purchaseOrderLine.findMany({
      where: { purchaseOrderId: poId, deletedAt: null, goodId: goodIds[0]! },
      select: { quantity: true, price: true },
    });
    expect(lines.length).toBe(1); // ЗЛИЛИСЬ, не задвоїлись
    expect(Number(lines[0]!.quantity)).toBeCloseTo(5, 6); // 2 + 3
    expect(Number(lines[0]!.price)).toBeCloseTo(120, 2); // нова ціна

    const t = await dbTotals(poId);
    expect(t.lineCount).toBe(1);
    expect(t.poTotalAmount).toBeCloseTo(5 * 120, 2); // 600
    expect(t.poTotalAmount).toBeCloseTo(t.sumQtyPrice, 2);
  });

  it('replace → наявні зникають, нові на місці, тотали лише по нових (пункт 5)', async () => {
    if (!dbAvailable) return;
    const poId = await createDraftPo();
    await raw.$transaction(async tx =>
      adapter.replaceLines(tx, orgId, poId, [
        { goodId: goodIds[0]!, quantity: 10, price: 10 },
        { goodId: goodIds[1]!, quantity: 10, price: 10 },
      ]),
    );
    let t = await dbTotals(poId);
    expect(t.lineCount).toBe(2);
    expect(t.poTotalAmount).toBeCloseTo(200, 2);

    // Replace одним іншим товаром.
    await raw.$transaction(async tx =>
      adapter.replaceLines(tx, orgId, poId, [{ goodId: goodIds[2]!, quantity: 1, price: 777 }]),
    );
    t = await dbTotals(poId);
    expect(t.lineCount).toBe(1); // старі soft-deleted
    expect(t.poTotalAmount).toBeCloseTo(777, 2);
    expect(t.poTotalAmount).toBeCloseTo(t.sumQtyPrice, 2);

    // Soft-delete: старі рядки мають deletedAt (не фізично видалені).
    const deleted = await raw.purchaseOrderLine.count({
      where: { purchaseOrderId: poId, deletedAt: { not: null } },
    });
    expect(deleted).toBe(2);
  });

  it('append scale: 600 наявних + 600 нових → SQL-сума по ВСІХ 1200, без зрізу на MAX_QUERY_LIMIT (пункт 7 / raw-SQL)', async () => {
    if (!dbAvailable) return;
    const poId = await createDraftPo();

    // 600 унікальних «віртуальних» товарів неможливо — у seed мало Good. Тож створюємо 1200
    // рядків прямим insert на 3 реальних goodId (дублікати goodId у РІЗНИХ рядках БД допустимі:
    // PO-line не має @@unique(docId, goodId)). Ціль — перевірити що SQL-SUM бачить усі рядки.
    const N = 1200;
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (let i = 0; i < N; i++) {
      const id = randomUUID();
      const good = goodIds[i % 3]!;
      // qty=1, price=1 → Σ = N; vatAmount=0.2 → Σvat = N*0.2
      values.push(
        `($${p++}::uuid, $${p++}::uuid, $${p++}::uuid, $${p++}::uuid, 1, 1, 20, 0.2, NOW(), NOW())`,
      );
      params.push(id, orgId, poId, good);
    }
    await raw.$executeRawUnsafe(
      `INSERT INTO purchase_order_lines
        (id, "orgId", "purchaseOrderId", "goodId", quantity, price, "vatRate", "vatAmount", "createdAt", "updatedAt")
       VALUES ${values.join(',')}`,
      ...params,
    );

    const before = await dbTotals(poId);
    expect(before.lineCount).toBe(N);

    // Append 1 новий рядок (новий goodId щоб не злитись із першими). Тотали перераховуються
    // SQL-агрегацією по ВСІХ активних рядках.
    await raw.$transaction(async tx =>
      adapter.appendLines(tx, orgId, poId, [{ goodId: goodIds[4]!, quantity: 2, price: 50 }]),
    );

    const after = await dbTotals(poId);
    // 1200 (злились по goodId у merge-мапі? ні — append дивиться на НАЯВНІ рядки, бачить перші
    // 1000 через take, але goodIds[4] НЕ серед них → створюється 1 новий рядок). Кількість рядків
    // зросла рівно на 1 (новий товар), наявні 1200 лишились.
    expect(after.lineCount).toBe(N + 1);
    // Ключова перевірка: SQL-SUM по ВСІХ 1201 рядках, БЕЗ зрізу на 1000.
    // Σ = 1200*(1*1) + 1*(2*50) = 1200 + 100 = 1300
    expect(after.poTotalAmount).toBeCloseTo(1300, 2);
    expect(after.poTotalAmount).toBeCloseTo(after.sumQtyPrice, 2);
    // Σvat = 1200*0.2 + vat нового рядка (EXCLUSIVE 20% від 100 = 20) = 240 + 20 = 260
    expect(after.poTotalVat).toBeCloseTo(after.sumVat, 2);
    expect(after.poTotalVat).toBeCloseTo(260, 1);
  }, 30_000);

  it('assertDraft: не-DRAFT документ → ForbiddenException (пункт 6)', async () => {
    if (!dbAvailable) return;
    expect(() => adapter.assertDraft('CONFIRMED')).toThrow();
    expect(() => adapter.assertDraft('DRAFT')).not.toThrow();
  });
});
