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

/**
 * A3 test-gap closure — дві крайові гілки writeOffPartsAndCharge/fetchPartCoefficients, які після
 * переїзду методів у WorkOrderStockEffectsService лишились без прямого покриття:
 *   1) zero-total throw на COMPLETED (chargeAmount <= 0 → BadRequestException);
 *   2) coeff=0 / legacy → safeCoeff→1 fallback (division-by-zero guard, baseQty=quantity/1).
 */

function makeGapService(opts: {
  totalAmount: number | null;
  parts?: Array<{ id: string; quantity: number; unitOfMeasureId?: string | null }>;
  goodUoM?: Array<{ goodId: string; unitOfMeasureId: string; coefficient: number }>;
}) {
  const parts = opts.parts ?? [{ id: 'part-1', quantity: 20, unitOfMeasureId: UOM_ID }];
  const prisma = {
    workOrderPart: {
      findMany: vi.fn().mockResolvedValue(
        parts.map(p => ({
          id: p.id,
          goodId: GOOD_ID,
          warehouseId: WH_ID,
          quantity: p.quantity,
          unitOfMeasureId: p.unitOfMeasureId ?? null,
        })),
      ),
      update: vi.fn().mockResolvedValue({}),
    },
    // WO-H1: chargeAmount береться з IN-TX re-read totalAmount → мок findFirst керує сумою боргу.
    workOrder: { findFirst: vi.fn().mockResolvedValue({ totalAmount: opts.totalAmount }) },
    goodUoM: { findMany: vi.fn().mockResolvedValue(opts.goodUoM ?? []) },
  } as unknown as PrismaService;
  const createMovement = vi
    .fn()
    .mockImplementation((_, dto) =>
      dto.type === 'WRITEOFF'
        ? Promise.resolve({ consumed: [{ batchId: 'b1' }], weightedCostPrice: 7 })
        : Promise.resolve({ consumed: [], weightedCostPrice: null }),
    );
  const inventory = { createMovement } as unknown as InventoryService;
  const createTransaction = vi.fn().mockResolvedValue({});
  const settlements = { createTransaction } as unknown as SettlementsService;
  return {
    svc: new WorkOrderStockEffectsService(prisma, inventory, settlements),
    createMovement,
    createTransaction,
  };
}

describe('WorkOrderStockEffectsService.writeOffPartsAndCharge — zero-total throw (A3 gap)', () => {
  it('chargeAmount<=0 (in-tx totalAmount=0) → BadRequestException, CHARGE НЕ створюється — MUTATION-VERIFY', async () => {
    const { svc, createTransaction } = makeGapService({ totalAmount: 0 });
    await expect(
      svc.writeOffPartsAndCharge(
        ORG,
        { id: 'wo-1', counterpartyId: 'cp-1', totalAmount: 0 as never },
        'user-1',
      ),
    ).rejects.toThrow('Загальна сума наряду дорівнює нулю');
    // Прибрати `if (chargeAmount <= 0) throw` → цей тест червоний (CHARGE(0) пройшов би тихо).
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it('in-tx re-read перекриває stale pre-tx суму: totalAmount pre-tx=500, freshWo=0 → throw', async () => {
    // Concurrent updatePart обнулив суму між pre-tx read і транзакцією — throw має спиратись
    // на freshWo (0), а не на stale-знімок wo (500). MUTATION: якщо код читав би wo.totalAmount
    // замість freshWo → CHARGE(500) на порожній наряд.
    const { svc, createTransaction } = makeGapService({ totalAmount: 0 });
    await expect(
      svc.writeOffPartsAndCharge(
        ORG,
        { id: 'wo-1', counterpartyId: 'cp-1', totalAmount: 500 as never },
        'user-1',
      ),
    ).rejects.toThrow('Загальна сума наряду дорівнює нулю');
    expect(createTransaction).not.toHaveBeenCalled();
  });
});

describe('WorkOrderStockEffectsService.fetchPartCoefficients — coeff=0/legacy safeCoeff→1 (A3 gap)', () => {
  it('GoodUoM.coefficient=0 (legacy/seed) → safeCoeff→1, baseQty=quantity (без Infinity) — MUTATION-VERIFY', async () => {
    // DTO @Min(0.000001) блокує 0 на write-path, але legacy/seed/direct-SQL можуть мати 0.
    // Без safeCoeff → quantity/0 = Infinity → WRITEOFF(-Infinity) отруїв би склад.
    const { svc, createMovement } = makeGapService({
      totalAmount: 500,
      parts: [{ id: 'part-1', quantity: 20, unitOfMeasureId: UOM_ID }],
      goodUoM: [{ goodId: GOOD_ID, unitOfMeasureId: UOM_ID, coefficient: 0 }],
    });
    await svc.writeOffPartsAndCharge(
      ORG,
      { id: 'wo-1', counterpartyId: 'cp-1', totalAmount: 500 as never },
      'user-1',
    );
    const writeoff = createMovement.mock.calls.find(c => c[1].type === 'WRITEOFF');
    // safeCoeff(0)→1 → baseQty=20/1=20 (скінченне). Замінити safeCoeff на `?? 1` → -Infinity, тест червоний.
    expect(writeoff?.[1].quantity).toBe(-20);
    expect(Number.isFinite(writeoff?.[1].quantity)).toBe(true);
  });

  it('GoodUoM-рядок відсутній (uom set, але lookup порожній) → safeCoeff(undefined)→1, baseQty=quantity', async () => {
    // part.unitOfMeasureId заданий, але goodUoM.findMany нічого не повернув (видалено/розсинхрон) —
    // coeffByGoodUom.get() = undefined → safeCoeff→1, а не NaN.
    const { svc, createMovement } = makeGapService({
      totalAmount: 500,
      parts: [{ id: 'part-1', quantity: 15, unitOfMeasureId: UOM_ID }],
      goodUoM: [], // порожній lookup
    });
    await svc.writeOffPartsAndCharge(
      ORG,
      { id: 'wo-1', counterpartyId: 'cp-1', totalAmount: 500 as never },
      'user-1',
    );
    const writeoff = createMovement.mock.calls.find(c => c[1].type === 'WRITEOFF');
    expect(writeoff?.[1].quantity).toBe(-15);
    expect(Number.isFinite(writeoff?.[1].quantity)).toBe(true);
  });
});
