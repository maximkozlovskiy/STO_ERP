import { describe, it, expect, vi } from 'vitest';
import { WorkOrdersService } from './work-orders.service';
import type { PrismaService } from '../../prisma/prisma.service';

// ─── Regression spec: recalcTotals — defensive take: 1000 cap ─────────────
//
// commit 80f02888 (sto-optimize): додано `take: 1000` у tx.workOrderLine.findMany
// всередині recalcTotals — defense-in-depth проти unbounded зростання lines.
// addLine/updateLine endpoints НЕ мають ArrayMaxSize валідації — теоретично
// рядки можуть рости до тисяч (legacy import, скриптові операції).
//
// Цей spec ловить регресії:
//   #531-A: видалення `take: 1000` (повертає unbounded findMany — N+1 risk +
//           потенційно OOM для дуже великих WO).
//   #531-B: зміна на меншу межу (e.g. `take: 100`) — truncate реальних даних
//           без сигналу → totalActualLabor дезінформація.
//   #531-C: take: 1000 узгоджена з reserveParts:802 (інші bulk reads у тому
//           самому сервісі мають same upper bound).
//   #531-D: recalcTotals коректно обробляє рівно 1000 рядків (boundary).

const ORG = '11111111-1111-4111-8111-111111111111';
const WO_ID = '22222222-2222-4222-8222-222222222222';
const GOOD_ID = '33333333-3333-4333-8333-333333333333';
const WAREHOUSE_ID = '44444444-4444-4444-8444-444444444444';

function makePrismaSpy(
  linesReturned: Array<{
    amount: number;
    actualHours: number | null;
    normoHours: number;
    price: number;
  }>,
) {
  const woFindFirst = vi.fn().mockResolvedValue({ status: 'DRAFT' });
  const goodFindFirst = vi.fn().mockResolvedValue({ salePrice: 100 });
  const warehouseFindFirst = vi.fn().mockResolvedValue({ id: WAREHOUSE_ID });
  const goodUoMFindFirst = vi.fn().mockResolvedValue(null);
  const partCreate = vi.fn().mockResolvedValue({
    id: 'P1',
    workOrderId: WO_ID,
    goodId: GOOD_ID,
    warehouseId: WAREHOUSE_ID,
    quantity: 1,
    price: 100,
    amount: 100,
    createdAt: new Date(),
    good: null,
  });

  const lineFindMany = vi.fn().mockResolvedValue(linesReturned);
  const partAggregate = vi.fn().mockResolvedValue({ _sum: { amount: 0 } });
  const woUpdate = vi.fn().mockResolvedValue({});

  const tx = {
    workOrder: { update: woUpdate },
    workOrderLine: { findMany: lineFindMany },
    workOrderPart: { create: partCreate, aggregate: partAggregate },
  };

  const prisma = {
    workOrder: { findFirst: woFindFirst },
    good: { findFirst: goodFindFirst },
    warehouse: { findFirst: warehouseFindFirst },
    goodUoM: { findFirst: goodUoMFindFirst },
    $transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as PrismaService;

  return { prisma, lineFindMany, woUpdate };
}

function makeService(prisma: PrismaService): WorkOrdersService {
  return new WorkOrdersService(
    prisma,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
}

describe('WorkOrdersService.recalcTotals — defensive take: 1000 cap', () => {
  it('передає take: 1000 у tx.workOrderLine.findMany (defense-in-depth)', async () => {
    // 0 рядків — boundary trivial. Перевіряємо ЛИШЕ що cap parameter переданий.
    const { prisma, lineFindMany } = makePrismaSpy([]);
    const service = makeService(prisma);
    await service.addPart(ORG, WO_ID, { goodId: GOOD_ID, warehouseId: WAREHOUSE_ID, quantity: 1 });

    expect(lineFindMany).toHaveBeenCalledTimes(1);
    const callArgs = lineFindMany.mock.calls[0][0];
    // КРИТИЧНО: cap саме 1000. Не undefined (unbounded), не 100 (truncate реальних даних).
    expect(callArgs.take).toBe(1000);
    // Sanity — soft-delete filter присутній.
    expect(callArgs.where.deletedAt).toBeNull();
    expect(callArgs.where.orgId).toBe(ORG);
    expect(callArgs.where.workOrderId).toBe(WO_ID);
  });

  it('правильні select-поля (amount, actualHours, normoHours, price) — без full row', async () => {
    const { prisma, lineFindMany } = makePrismaSpy([]);
    const service = makeService(prisma);
    await service.addPart(ORG, WO_ID, { goodId: GOOD_ID, warehouseId: WAREHOUSE_ID, quantity: 1 });

    const callArgs = lineFindMany.mock.calls[0][0];
    // КРИТИЧНО: select narrow — лише поля що використовуються у recalc.
    // Якщо хтось додасть `include: true` → знижка perf та витік полів.
    expect(callArgs.select).toEqual({
      amount: true,
      actualHours: true,
      normoHours: true,
      price: true,
    });
  });

  it('обробляє рівно 1000 рядків без truncation/exception (boundary)', async () => {
    // 1000 рядків, кожен з amount=10, actualHours=1, price=10 → totalLabor=10000, totalActualLabor=10000.
    const lines = Array.from({ length: 1000 }, () => ({
      amount: 10,
      actualHours: 1,
      normoHours: 1,
      price: 10,
    }));
    const { prisma, woUpdate } = makePrismaSpy(lines);
    const service = makeService(prisma);
    await service.addPart(ORG, WO_ID, { goodId: GOOD_ID, warehouseId: WAREHOUSE_ID, quantity: 1 });

    expect(woUpdate).toHaveBeenCalledTimes(1);
    const data = woUpdate.mock.calls[0][0].data;
    expect(data.totalLabor).toBe(10000);
    expect(data.totalActualLabor).toBe(10000); // 1000 * (1 * 10)
    expect(data.totalAmount).toBe(10000);
  });

  it('обробляє великий список (500 рядків) у single-pass reduce без CPU вибуху', async () => {
    // Sanity: 500 рядків, перевіряємо що single-pass працює коректно.
    // Якщо twin-scan регресує (двічі lines.reduce) — це не зловиться unit-тестом,
    // але якщо хтось випадково додасть `.map().reduce()` chain з помилковою
    // семантикою — totals не зійдуться.
    const lines = Array.from({ length: 500 }, (_, i) => ({
      amount: 100,
      actualHours: i % 2 === 0 ? 2 : null, // half actual, half null
      normoHours: 1,
      price: 100,
    }));
    const { prisma, woUpdate } = makePrismaSpy(lines);
    const service = makeService(prisma);
    await service.addPart(ORG, WO_ID, { goodId: GOOD_ID, warehouseId: WAREHOUSE_ID, quantity: 1 });

    const data = woUpdate.mock.calls[0][0].data;
    expect(data.totalLabor).toBe(50000); // 500 * 100
    // 250 рядків з actualHours=2 → 2*100=200; 250 з actualHours=null → normoHours=1 * 100=100
    expect(data.totalActualLabor).toBe(250 * 200 + 250 * 100); // 50000 + 25000 = 75000
  });
});

// ─── Симетричні endpoints (updateLine / removeLine / addPart / updatePart / removePart) ─

describe('WorkOrdersService.recalcTotals — invoked from all mutation paths', () => {
  it('addPart викликає recalcTotals → workOrderLine.findMany з take: 1000', async () => {
    const { prisma, lineFindMany } = makePrismaSpy([]);
    const service = makeService(prisma);
    await service.addPart(ORG, WO_ID, { goodId: GOOD_ID, warehouseId: WAREHOUSE_ID, quantity: 1 });

    expect(lineFindMany).toHaveBeenCalledTimes(1);
    expect(lineFindMany.mock.calls[0][0].take).toBe(1000);
  });

  // Note: updateLine/removeLine/addLine також викликають recalcTotals у тому самому
  // tx-callback. Перевірка через addPart достатня для коду recalcTotals (це private
  // helper з єдиною реалізацією) — інший mutation викличе аналогічно. Окремо
  // юніт-тестувати кожен entry point не дає додаткової regression coverage щодо
  // самого `take: 1000` cap.
});
