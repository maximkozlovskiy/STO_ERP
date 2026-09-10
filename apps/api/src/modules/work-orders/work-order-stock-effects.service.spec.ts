import { describe, it, expect, vi } from 'vitest';
import { WorkOrderStockEffectsService } from './work-order-stock-effects.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { InventoryService } from '../inventory/inventory.service';
import type { SettlementsService } from '../settlements/settlements.service';

/**
 * A3 — WorkOrderStockEffectsService (винесено з WorkOrdersService.transition). Основне логічне
 * покриття stock-математики (writeoff/charge/return/coeff) лишається у work-orders.service.spec
 * (через ті самі методи цього сервісу). Тут — точковий mutation-verified guard на A3-фікс:
 * fetchPartCoefficients ТЕПЕР фільтрує GoodUoM за orgId (без цього A1-tenant-guard кидав би на
 * transition із UoM-запчастиною + крос-tenant-ризик коефіцієнта чужої org).
 */

const ORG = 'org-1';
const GOOD_ID = '11111111-1111-4111-8111-111111111111';
const UOM_ID = '22222222-2222-4222-8222-222222222222';
const WH_ID = '33333333-3333-4333-8333-333333333333';

function makeService(goodUoMFindMany: ReturnType<typeof vi.fn>) {
  const prisma = {
    workOrderPart: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'part-1',
          goodId: GOOD_ID,
          warehouseId: WH_ID,
          quantity: 20,
          unitOfMeasureId: UOM_ID,
        },
      ]),
      update: vi.fn().mockResolvedValue({}),
    },
    workOrder: { findFirst: vi.fn().mockResolvedValue({ totalAmount: 500 }) },
    goodUoM: { findMany: goodUoMFindMany },
  } as unknown as PrismaService;
  const inventory = {
    createMovement: vi
      .fn()
      .mockImplementation((_, dto) =>
        dto.type === 'WRITEOFF'
          ? Promise.resolve({ consumed: [{ batchId: 'b1' }], weightedCostPrice: 7 })
          : Promise.resolve({ consumed: [], weightedCostPrice: null }),
      ),
  } as unknown as InventoryService;
  const settlements = {
    createTransaction: vi.fn().mockResolvedValue({}),
  } as unknown as SettlementsService;
  return new WorkOrderStockEffectsService(prisma, inventory, settlements);
}

describe('WorkOrderStockEffectsService.fetchPartCoefficients — tenant-scope (A3)', () => {
  it('GoodUoM-lookup несе orgId у where (tenant-isolation) — MUTATION-VERIFY', async () => {
    const goodUoMFindMany = vi
      .fn()
      .mockResolvedValue([{ goodId: GOOD_ID, unitOfMeasureId: UOM_ID, coefficient: 10 }]);
    const svc = makeService(goodUoMFindMany);

    await svc.writeOffPartsAndCharge(
      ORG,
      { id: 'wo-1', counterpartyId: 'cp-1', totalAmount: 500 as never },
      'user-1',
    );

    // Ключова A3-зміна: orgId ПРИСУТНІЙ у where. Прибрати `orgId` з goodUoM.findMany-where →
    // цей тест червоний (tenant-scope зникає, і A1-guard кидав би наживо).
    expect(goodUoMFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: ORG,
          unitOfMeasureId: { in: [UOM_ID] },
          goodId: { in: [GOOD_ID] },
        }),
      }),
    );
  });

  it('coeff застосовується: baseQty = quantity / coefficient (20 / 10 = 2)', async () => {
    const goodUoMFindMany = vi
      .fn()
      .mockResolvedValue([{ goodId: GOOD_ID, unitOfMeasureId: UOM_ID, coefficient: 10 }]);
    const svc = makeService(goodUoMFindMany);
    const inventorySpy = (
      svc as unknown as { inventory: { createMovement: ReturnType<typeof vi.fn> } }
    ).inventory.createMovement;

    await svc.writeOffPartsAndCharge(
      ORG,
      { id: 'wo-1', counterpartyId: 'cp-1', totalAmount: 500 as never },
      'user-1',
    );

    const writeoff = inventorySpy.mock.calls.find(c => c[1].type === 'WRITEOFF');
    expect(writeoff?.[1].quantity).toBe(-2);
  });
});
