/**
 * Кількість повернення на складі при скасуванні наряду — те, що рядок РЕАЛЬНО списав (BR-WO-039).
 *
 * `returnPartsAndCredit` рахував RETURN як `part.quantity × поточний коефіцієнт одиниці`. Коефіцієнт
 * товару можна змінити між «Виконано» і «Скасувати» (`PATCH /goods/:id/uoms/:uomId`): наживо 2 «Пак»
 * при 10 списали 20 шт; коефіцієнт 12 → повернулось 24 (4 одиниці без партій, Σ партій ≠ залишок),
 * коефіцієнт 1 → повернулось 2 (18 шт зникли). Тепер кількість — Σ від'ємних `BatchConsumption` рядка;
 * записів рядка немає (списання до появи `documentLineId`) — перерахунок, як раніше.
 */
import { describe, it, expect, vi } from 'vitest';
import { WorkOrderStockEffectsService } from './work-order-stock-effects.service';
import type { PrismaService } from '../../prisma/prisma.service';

const ORG = 'org-1';
const WO = { id: 'wo-1', counterpartyId: 'cp-1', totalAmount: 1000 as never };
const GOOD = '11111111-1111-4111-8111-111111111111';
const UOM = '22222222-2222-4222-8222-222222222222';
const WH = '33333333-3333-4333-8333-333333333333';

function makeSvc(opts: {
  parts: Array<{ id: string; quantity: number; unitOfMeasureId?: string | null }>;
  coefficient: number;
  written: Array<{ documentLineId: string; qty: number }>;
}) {
  const groupBy = vi
    .fn()
    .mockResolvedValue(
      opts.written.map(w => ({ documentLineId: w.documentLineId, _sum: { quantity: -w.qty } })),
    );
  const createMovement = vi.fn().mockResolvedValue({ consumed: [], weightedCostPrice: null });
  const prisma = {
    workOrderPart: {
      findMany: vi.fn().mockResolvedValue(
        opts.parts.map(p => ({
          id: p.id,
          goodId: GOOD,
          warehouseId: WH,
          quantity: p.quantity,
          unitOfMeasureId: p.unitOfMeasureId ?? null,
        })),
      ),
    },
    workOrder: { findFirst: vi.fn().mockResolvedValue({ totalAmount: 1000 }) },
    settlementTransaction: { findFirst: vi.fn().mockResolvedValue(null) },
    goodUoM: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ goodId: GOOD, unitOfMeasureId: UOM, coefficient: opts.coefficient }]),
    },
    batchConsumption: { groupBy },
  } as unknown as PrismaService;
  const svc = new WorkOrderStockEffectsService(
    prisma,
    { createMovement } as never,
    { createTransaction: vi.fn().mockResolvedValue({}) } as never,
    null as never,
    {
      onWorkOrderClosed: () => Promise.resolve(),
      onWorkOrderPartsChanged: () => Promise.resolve(),
    } as never,
  );
  const returns = () =>
    createMovement.mock.calls
      .map(c => c[1] as { type: string; quantity: number; documentLineId: string })
      .filter(d => d.type === 'RETURN');
  return { svc, groupBy, returns };
}

describe('returnPartsAndCredit — кількість RETURN = списане рядком (BR-WO-039)', () => {
  // guards: BR-WO-039
  it('коефіцієнт одиниці змінено після «Виконано» (10 → 12): повертається списане 20, а не 24', async () => {
    const { svc, returns } = makeSvc({
      parts: [{ id: 'part-1', quantity: 2, unitOfMeasureId: UOM }],
      coefficient: 12,
      written: [{ documentLineId: 'part-1', qty: 20 }],
    });

    await svc.returnPartsAndCredit(ORG, WO, 'user-1');

    expect(returns()).toEqual([
      expect.objectContaining({ documentLineId: 'part-1', quantity: 20 }),
    ]);
  });

  // guards: BR-WO-039
  it('коефіцієнт зменшено (10 → 1): повертається 20, а не 2', async () => {
    const { svc, returns } = makeSvc({
      parts: [{ id: 'part-1', quantity: 2, unitOfMeasureId: UOM }],
      coefficient: 1,
      written: [{ documentLineId: 'part-1', qty: 20 }],
    });

    await svc.returnPartsAndCredit(ORG, WO, 'user-1');

    expect(returns()[0]!.quantity).toBe(20);
  });

  // guards: BR-WO-039
  it('кожен рядок — своє списане; рядок без записів списання — перерахунок за коефіцієнтом', async () => {
    const { svc, returns } = makeSvc({
      parts: [
        { id: 'part-1', quantity: 2, unitOfMeasureId: UOM },
        { id: 'part-2', quantity: 3, unitOfMeasureId: UOM },
      ],
      coefficient: 5,
      written: [{ documentLineId: 'part-1', qty: 7 }],
    });

    await svc.returnPartsAndCredit(ORG, WO, 'user-1');

    expect(returns().map(r => [r.documentLineId, r.quantity])).toEqual([
      ['part-1', 7],
      ['part-2', 15],
    ]);
  });

  // guards: BR-WO-039
  it('списане читається лише з від’ємних записів цього наряду й його рядків, в org', async () => {
    const { svc, groupBy } = makeSvc({
      parts: [{ id: 'part-1', quantity: 2, unitOfMeasureId: UOM }],
      coefficient: 10,
      written: [],
    });

    await svc.returnPartsAndCredit(ORG, WO, 'user-1');

    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['documentLineId'],
        where: {
          orgId: ORG,
          documentType: 'WorkOrder',
          documentId: WO.id,
          documentLineId: { in: ['part-1'] },
          quantity: { lt: 0 },
        },
      }),
    );
  });
});
