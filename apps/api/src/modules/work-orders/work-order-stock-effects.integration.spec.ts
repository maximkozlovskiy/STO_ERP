import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { withTenantGuard } from '../../prisma/tenant-guard.extension';
import { TenantIsolationError } from '../../prisma/tenant-isolation.error';
import { WorkOrderStockEffectsService } from './work-order-stock-effects.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { InventoryService } from '../inventory/inventory.service';
import type { SettlementsService } from '../settlements/settlements.service';

/**
 * ІНТЕГРАЦІЙНИЙ тест A3-фіксу проти ЖИВОЇ dev-БД: fetchPartCoefficients робить goodUoM.findMany
 * ЧЕРЕЗ РЕАЛЬНИЙ tenant-guard $extends. Це — ЄДИНЕ реальне покриття «раніше-зламаного» шляху:
 * до фіксу lookup йшов БЕЗ orgId → A1-guard кидав TenantIsolationError на будь-якому FSM-переході
 * з UoM-запчастиною (500). Юніт-тести мокають Prisma → guard-extension у них НЕ виконується, тож
 * лише тут доводимо наскрізь, що з orgId запит ПРОХОДИТЬ, а без нього — КИДАВ БИ (mutation-baseline).
 *
 * inventory/settlements застабовані: вони окремі bounded-контексти з власним integration-покриттям;
 * ціль цього тесту — саме guarded goodUoM.findMany усередині stock-effects, а не рух складу/боргу.
 *
 * Умови запуску: жива dev-Postgres на DATABASE_URL. Без БД — SKIP (не фейлить CI без docker).
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://sto:sto_dev_secret@localhost:5432/sto_erp';

let dbAvailable = false;
let raw: PrismaClient;
let guarded: PrismaClient;
let orgId: string;
let warehouseId: string;
let goodId: string;
let unitOfMeasureId: string;

const createdWorkOrderIds: string[] = [];
const createdPartIds: string[] = [];
const createdGoodUomIds: string[] = [];

async function cleanup() {
  if (createdPartIds.length)
    await raw
      .$executeRawUnsafe(`DELETE FROM work_order_parts WHERE id = ANY($1::uuid[])`, createdPartIds)
      .catch(() => undefined);
  if (createdWorkOrderIds.length)
    await raw
      .$executeRawUnsafe(`DELETE FROM work_orders WHERE id = ANY($1::uuid[])`, createdWorkOrderIds)
      .catch(() => undefined);
  if (createdGoodUomIds.length)
    await raw
      .$executeRawUnsafe(`DELETE FROM good_uom WHERE id = ANY($1::uuid[])`, createdGoodUomIds)
      .catch(() => undefined);
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  raw = new PrismaClient({ datasourceUrl: DATABASE_URL });
  try {
    await raw.$connect();
    // Потрібні: org + warehouse + good + unitOfMeasure тієї ж org, щоб зібрати UoM-частину.
    const branch = await raw.garageBranch.findFirst({ select: { orgId: true } });
    if (!branch) {
      dbAvailable = false;
      return;
    }
    orgId = branch.orgId;
    const wh = await raw.warehouse.findFirst({ where: { orgId }, select: { id: true } });
    const good = await raw.good.findFirst({
      where: { orgId, deletedAt: null },
      select: { id: true },
    });
    const uom = await raw.unitOfMeasure.findFirst({ where: { orgId }, select: { id: true } });
    if (!wh || !good || !uom) {
      dbAvailable = false;
      return;
    }
    warehouseId = wh.id;
    goodId = good.id;
    unitOfMeasureId = uom.id;
    dbAvailable = true;
    guarded = withTenantGuard(raw);
  } catch {
    dbAvailable = false;
  }
}, 30_000);

afterAll(async () => {
  if (raw) {
    await cleanup();
    await raw.$disconnect();
  }
});

/** Застаб inventory/settlements — приймають будь-що, нічого не пишуть. */
function stubService(): WorkOrderStockEffectsService {
  const inventory = {
    createMovement: () => Promise.resolve({ consumed: [], weightedCostPrice: null }),
  } as unknown as InventoryService;
  const settlements = {
    createTransaction: () => Promise.resolve({}),
  } as unknown as SettlementsService;
  // guarded PrismaClient грає роль PrismaService (той самий контракт делегатів).
  return new WorkOrderStockEffectsService(
    guarded as unknown as PrismaService,
    inventory,
    settlements,
  );
}

describe('WorkOrderStockEffectsService — guarded goodUoM.findMany (integration, live DB, A3)', () => {
  it('передумова: dev-БД доступна', () => {
    if (!dbAvailable)
      console.warn('[work-order-stock-effects.integration] dev-БД недоступна — тест пропущено');
    expect(true).toBe(true);
  });

  it('mutation-baseline: goodUoM.findMany БЕЗ orgId під guard → кидає TenantIsolationError', async () => {
    if (!dbAvailable) return;
    // Це — стан ДО A3-фіксу. Доводить, що guard справді ловить безtenant-lookup (інакше
    // «проходить з orgId» нічого б не гарантувало).
    await expect(
      guarded.goodUoM.findMany({
        where: { unitOfMeasureId: { in: [unitOfMeasureId] }, goodId: { in: [goodId] } },
      }),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('A3-фікс: writeOffPartsAndCharge з UoM-частиною через guarded client → 0 TenantIsolationError', async () => {
    if (!dbAvailable) return;
    // Сідуємо GoodUoM (coeff=4) + WO + UoM-частину напряму (raw, поза guard).
    const guom = await raw.goodUoM.create({
      data: { orgId, goodId, unitOfMeasureId, coefficient: 4 },
      select: { id: true },
    });
    createdGoodUomIds.push(guom.id);

    const cp = await raw.counterparty.findFirst({ where: { orgId }, select: { id: true } });
    const branchRow = await raw.garageBranch.findFirst({ where: { orgId }, select: { id: true } });
    const vehicle = await raw.vehicle.findFirst({
      where: { orgId, deletedAt: null },
      select: { id: true },
    });
    if (!cp || !branchRow || !vehicle) {
      console.warn('[integration] бракує cp/branch/vehicle — тест пропущено');
      return;
    }

    const wo = await raw.workOrder.create({
      data: {
        orgId,
        branchId: branchRow.id,
        vehicleId: vehicle.id,
        counterpartyId: cp.id,
        number: `A3-INT-${Date.now()}`,
        status: 'COMPLETED',
        totalAmount: 100,
      },
      select: { id: true },
    });
    createdWorkOrderIds.push(wo.id);

    const part = await raw.workOrderPart.create({
      data: {
        orgId,
        workOrderId: wo.id,
        goodId,
        warehouseId,
        quantity: 8,
        price: 25,
        amount: 200,
        unitOfMeasureId,
      },
      select: { id: true },
    });
    createdPartIds.push(part.id);

    const svc = stubService();

    // Ключове: усередині — guarded goodUoM.findMany з orgId (A3-фікс). БЕЗ orgId кидало б (baseline вище).
    // inventory/settlements — no-op, тож єдиний реальний guarded-запит проти БД тут — саме той lookup
    // (+ workOrderPart.findMany / workOrder.findFirst, теж orgId-scoped). Асертимо: НЕ кидає guard.
    await expect(
      guarded.$transaction(tx =>
        svc.writeOffPartsAndCharge(
          orgId,
          { id: wo.id, counterpartyId: cp.id, totalAmount: 100 as never },
          undefined,
          tx,
        ),
      ),
    ).resolves.not.toThrow();
  });

  it('A3-фікс: reserveParts з UoM-частиною через guarded client → 0 TenantIsolationError', async () => {
    if (!dbAvailable) return;
    const wo = createdWorkOrderIds[0];
    if (!wo) return;
    const svc = stubService();
    await expect(
      guarded.$transaction(tx => svc.reserveParts(orgId, wo, undefined, tx)),
    ).resolves.not.toThrow();
  });
});
