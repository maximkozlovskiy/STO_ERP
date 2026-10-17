import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Prisma } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { createPgAdapter } from '../../prisma/pg-adapter';
import { withTenantGuard } from '../../prisma/tenant-guard.extension';
import { handleDbUnavailable, testDatabaseUrl } from '../../common/testing/require-db';
import { InventoryService } from '../inventory/inventory.service';
import { WorkOrderStockEffectsService } from '../work-orders/work-order-stock-effects.service';
import { netReservedByWorkOrder } from '../work-orders/work-order-stock-requirements';
import { PurchaseListLinkService } from './purchase-list-link.service';
import { PurchaseListReceiptService } from './purchase-list-receipt.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { BatchService } from '../inventory/batch.service';
import type { SettingsService } from '../settings/settings.service';

/**
 * ІНТЕГРАЦІЙНИЙ спек проти ЖИВОЇ dev-БД: приймання замовлення постачальнику, що резервує отримане
 * під наряд (BR-PL-011), і скасування того самого наряду (BR-WO-021) — ОДНОЧАСНО.
 *
 * Unit-спеки над таблицями в пам'яті не бачать блокувань Postgres. Тут обидві транзакції справді
 * конкурують за рядок наряду й рядок залишку:
 *  - приймання: `lockCandidateWorkOrders` (FOR UPDATE наряду) → прихід на склад → `allocateOnReceipt`;
 *  - скасування: CAS статусу наряду (блокує той самий рядок) → `releaseAllNetReservations`.
 * Порядок блокувань в обох «наряд → склад», тож deadlock (40P01) неможливий, а результат не
 * залежить від того, хто перший: скасований наряд не тримає резерву, позиція отримала товар,
 * `reservedQty` позиції — 0, `stock_items.reserved` — 0.
 *
 * Прихід емулюється прямим збільшенням `stock_items.quantity` у транзакції приймання ПІСЛЯ
 * блокування нарядів — той самий порядок, що й у `PurchaseOrdersService.receive` (рух RECEIPT із
 * партією тут не потрібен: досліджується резерв, не собівартість).
 *
 * Умови запуску: жива dev-Postgres на DATABASE_URL. Без БД — SKIP (у CI з REQUIRE_DB=1 — падіння).
 */

const DATABASE_URL = testDatabaseUrl();
const ROUNDS = 6;
const QTY = 3;

let dbAvailable = false;
let raw: PrismaClient;
let guarded: PrismaClient;
let orgId: string;
let warehouseId: string;
let template: { branchId: string; vehicleId: string; counterpartyId: string; currencyId: string };

const stamp = Date.now();
const ids = {
  goods: [] as string[],
  workOrders: [] as string[],
  purchaseOrders: [] as string[],
  lists: [] as string[],
};

async function cleanup() {
  if (!raw) return;
  const run = (sql: string, list: string[]) =>
    list.length ? raw.$executeRawUnsafe(sql, list).catch(() => undefined) : Promise.resolve();
  await run(`DELETE FROM purchase_list_items WHERE "listId" = ANY($1::uuid[])`, ids.lists);
  await run(`DELETE FROM purchase_lists WHERE id = ANY($1::uuid[])`, ids.lists);
  await run(`DELETE FROM purchase_orders WHERE id = ANY($1::uuid[])`, ids.purchaseOrders);
  await run(`DELETE FROM work_order_parts WHERE "workOrderId" = ANY($1::uuid[])`, ids.workOrders);
  await run(`DELETE FROM work_orders WHERE id = ANY($1::uuid[])`, ids.workOrders);
  if (ids.goods.length) {
    // Рухи складу append-only (тригер блокує DELETE) — вимикаємо його лише на час прибирання.
    await raw
      .$executeRawUnsafe(
        `ALTER TABLE stock_movements DISABLE TRIGGER trg_stock_movements_immutable`,
      )
      .catch(() => undefined);
    await run(`DELETE FROM stock_movements WHERE "goodId" = ANY($1::uuid[])`, ids.goods);
    await raw
      .$executeRawUnsafe(`ALTER TABLE stock_movements ENABLE TRIGGER trg_stock_movements_immutable`)
      .catch(() => undefined);
  }
  await run(`DELETE FROM stock_items WHERE "goodId" = ANY($1::uuid[])`, ids.goods);
  await run(`DELETE FROM goods WHERE id = ANY($1::uuid[])`, ids.goods);
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  raw = new PrismaClient({ adapter: createPgAdapter(DATABASE_URL) });
  try {
    await raw.$connect();
    await raw.$queryRawUnsafe(`SELECT 1 FROM "purchase_list_items" LIMIT 0`);
  } catch {
    handleDbUnavailable('підключення недоступне або міграції списків купівлі не застосовані');
    return;
  }
  // БД доступна: брак довідників seed — падіння, а не тихий пропуск.
  const branch = await raw.garageBranch.findFirst({
    where: { deletedAt: null },
    select: { id: true, orgId: true },
  });
  if (!branch) throw new Error('seed: немає філії');
  orgId = branch.orgId;
  const [vehicle, counterparty, currency, warehouse] = await Promise.all([
    raw.vehicle.findFirst({ where: { orgId, deletedAt: null }, select: { id: true } }),
    raw.counterparty.findFirst({ where: { orgId, deletedAt: null }, select: { id: true } }),
    raw.currency.findFirst({ where: { orgId }, select: { id: true } }),
    raw.warehouse.findFirst({ where: { orgId, deletedAt: null }, select: { id: true } }),
  ]);
  if (!vehicle || !counterparty || !currency || !warehouse)
    throw new Error('seed: немає авто, контрагента, валюти чи складу');
  template = {
    branchId: branch.id,
    vehicleId: vehicle.id,
    counterpartyId: counterparty.id,
    currencyId: currency.id,
  };
  warehouseId = warehouse.id;
  guarded = withTenantGuard(raw);
  dbAvailable = true;
}, 30_000);

afterAll(async () => {
  await cleanup();
  if (raw) await raw.$disconnect().catch(() => undefined);
});

function services() {
  const prisma = guarded as unknown as PrismaService;
  // Резерв і зняття резерву не чіпають партій і налаштувань собівартості (BR-INVT-004).
  const inventory = new InventoryService(
    prisma,
    {} as unknown as BatchService,
    {} as unknown as SettingsService,
  );
  const link = new PurchaseListLinkService();
  const receipt = new PurchaseListReceiptService(inventory);
  const effects = new WorkOrderStockEffectsService(
    prisma,
    inventory,
    null as never, // settlements — скасування з APPROVED боргу не чіпає
    null as never, // exchangeRates — не задіяні
    link,
  );
  return { receipt, effects };
}

/** Товар без залишку, наряд APPROVED із рядком на QTY, замовлення і ORDERED-позиція під наряд. */
async function seedRound(i: number) {
  const good = await raw.good.create({
    data: { orgId, name: `PL-IT ${stamp}-${i}`, salePrice: 100 },
    select: { id: true },
  });
  ids.goods.push(good.id);
  await raw.stockItem.create({ data: { orgId, goodId: good.id, warehouseId } });
  const wo = await raw.workOrder.create({
    data: { orgId, ...template, number: `PL-IT-${stamp}-${i}`, status: 'APPROVED' },
    select: { id: true },
  });
  ids.workOrders.push(wo.id);
  const part = await raw.workOrderPart.create({
    data: {
      orgId,
      workOrderId: wo.id,
      goodId: good.id,
      warehouseId,
      quantity: QTY,
      price: 100,
      amount: 100 * QTY,
    },
    select: { id: true },
  });
  const po = await raw.purchaseOrder.create({
    data: {
      orgId,
      supplierId: template.counterpartyId,
      warehouseId,
      currencyId: template.currencyId,
      number: `PL-IT-PO-${stamp}-${i}`,
      status: 'ORDERED',
    },
    select: { id: true },
  });
  ids.purchaseOrders.push(po.id);
  const list = await raw.purchaseList.create({
    data: { orgId, number: `PL-IT-L-${stamp}-${i}` },
    select: { id: true },
  });
  ids.lists.push(list.id);
  const item = await raw.purchaseListItem.create({
    data: {
      orgId,
      listId: list.id,
      goodId: good.id,
      warehouseId,
      quantity: QTY,
      status: 'ORDERED',
      source: 'WORK_ORDER',
      workOrderId: wo.id,
      workOrderPartId: part.id,
      purchaseOrderId: po.id,
    },
    select: { id: true },
  });
  return { goodId: good.id, woId: wo.id, poId: po.id, itemId: item.id };
}

type Round = Awaited<ReturnType<typeof seedRound>>;
type Svc = ReturnType<typeof services>;

function receiveTx(svc: Svc, r: Round) {
  return guarded.$transaction(async tx => {
    const t = tx as unknown as Prisma.TransactionClient;
    await svc.receipt.lockCandidateWorkOrders(t, orgId, r.poId, [r.goodId]);
    await t.$executeRaw`
      UPDATE stock_items SET quantity = quantity + ${QTY}
      WHERE "orgId" = ${orgId}::uuid AND "goodId" = ${r.goodId}::uuid
        AND "warehouseId" = ${warehouseId}::uuid`;
    await svc.receipt.allocateOnReceipt(t, orgId, { id: r.poId, warehouseId }, [
      { goodId: r.goodId, quantity: QTY },
    ]);
  });
}

function cancelTx(svc: Svc, r: Round) {
  return guarded.$transaction(async tx => {
    const t = tx as unknown as Prisma.TransactionClient;
    // Як transition(): CAS статусу блокує рядок наряду, далі — побічні ефекти в тій самій tx.
    const res = await t.workOrder.updateMany({
      where: { id: r.woId, orgId, status: 'APPROVED' },
      data: { status: 'CANCELLED' },
    });
    if (res.count !== 1) throw new Error('CAS скасування не спрацював');
    await svc.effects.releaseAllNetReservations(orgId, r.woId, undefined, t);
  });
}

async function state(r: Round) {
  const [stock, item, net] = await Promise.all([
    raw.stockItem.findFirst({
      where: { orgId, goodId: r.goodId, warehouseId },
      select: { quantity: true, reserved: true },
    }),
    raw.purchaseListItem.findFirst({
      where: { id: r.itemId },
      select: { status: true, receivedQty: true, reservedQty: true },
    }),
    netReservedByWorkOrder(raw as never, orgId, r.woId),
  ]);
  const woNet = Array.from(net.values()).reduce((s, v) => s + v, 0);
  return { stock, item, woNet };
}

describe('Приймання ‖ скасування наряду — блокування й резерв (integration, live DB)', () => {
  it('контроль: приймання без скасування резервує отримане під наряд (BR-PL-011)', async () => {
    if (!dbAvailable) return;
    const svc = services();
    const r = await seedRound(0);
    await receiveTx(svc, r);
    const s = await state(r);
    expect(s.stock).toEqual({ quantity: QTY, reserved: QTY });
    expect(s.item).toEqual({ status: 'RECEIVED', receivedQty: QTY, reservedQty: QTY });
    expect(s.woNet).toBe(QTY);
  });

  it('одночасні приймання й скасування: без deadlock, скасований наряд резерву не тримає', async () => {
    if (!dbAvailable) return;
    const svc = services();
    for (let i = 1; i <= ROUNDS; i++) {
      const r = await seedRound(i);
      // Почергово змінюємо, хто стартує першим, — обидві транзакції в польоті одночасно.
      const runs =
        i % 2 ? [receiveTx(svc, r), cancelTx(svc, r)] : [cancelTx(svc, r), receiveTx(svc, r)];
      const settled = await Promise.allSettled(runs);
      const failed = settled.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
      expect(
        failed.map(f => String(f.reason)),
        `раунд ${i}`,
      ).toEqual([]);

      const s = await state(r);
      expect(s.stock, `раунд ${i}: залишок`).toEqual({ quantity: QTY, reserved: 0 });
      expect(s.woNet, `раунд ${i}: net-резерв наряду`).toBe(0);
      expect(s.item, `раунд ${i}: позиція`).toEqual({
        status: 'RECEIVED',
        receivedQty: QTY,
        reservedQty: 0,
      });
    }
  }, 120_000);
});
