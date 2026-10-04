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
    // Bug #780: writeOffPartsAndCharge читає власні RESERVATION-рухи наряду. [] → ON_HOLD-шлях
    // (резерву не було) — RELEASE пропускається, WRITEOFF усе одно фіксує coeff/COGS.
    stockMovement: { findMany: vi.fn().mockResolvedValue([]) },
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

  it('netReservedByWorkOrder несе orgId + documentId у where (tenant-isolation) — MUTATION-VERIFY', async () => {
    // Знайдено security-review ЦИКЛ 2/3: мутація «прибрати orgId з цього where» ВИЖИВАЛА —
    // усі 12 тестів лишались зеленими. Тобто tenant-scope НОВОГО запиту (Bug #780) не був
    // покритий, на відміну від сусіднього goodUoM-lookup. Рантайм захищений A1-guard-ом,
    // але регресія мовчки проходила б unit-рівень. Дзеркалить патерн тесту вище.
    const goodUoMFindMany = vi
      .fn()
      .mockResolvedValue([{ goodId: GOOD_ID, unitOfMeasureId: UOM_ID, coefficient: 10 }]);
    const svc = makeService(goodUoMFindMany);
    const movementFindMany = (
      svc as unknown as { prisma: { stockMovement: { findMany: ReturnType<typeof vi.fn> } } }
    ).prisma.stockMovement.findMany;

    await svc.writeOffPartsAndCharge(
      ORG,
      { id: 'wo-1', counterpartyId: 'cp-1', totalAmount: 500 as never },
      'user-1',
    );

    expect(movementFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: ORG,
          documentType: 'WorkOrder',
          documentId: 'wo-1',
        }),
      }),
    );
  });

  it('coeff застосовується: baseQty = quantity * coefficient (20 * 10 = 200)', async () => {
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
    expect(writeoff?.[1].quantity).toBe(-200);
  });
});

/**
 * A3 test-gap closure — дві крайові гілки writeOffPartsAndCharge/fetchPartCoefficients, які після
 * переїзду методів у WorkOrderStockEffectsService лишились без прямого покриття:
 *   1) zero-total throw на COMPLETED (chargeAmount <= 0 → BadRequestException);
 *   2) coeff=0 / legacy → safeCoeff→1 fallback (guard, baseQty=quantity*1=quantity).
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
    // Bug #780: власні RESERVATION-рухи наряду (порожньо → без зайвого RELEASE у gap-тестах).
    stockMovement: { findMany: vi.fn().mockResolvedValue([]) },
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
    // Без safeCoeff → coeff=0 → WRITEOFF(0) знулив би списання; safeCoeff(0)→1 → baseQty=quantity.
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
    // safeCoeff(0)→1 → baseQty=20*1=20. Без guard: coeff=0 → baseQty=0 → WRITEOFF(0), тест червоний.
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

/**
 * Bug #780 — writeOffPartsAndCharge безумовно звільняв резерв (RESERVATION_RELEASE(-baseQty))
 * ПРИПУСКАЮЧИ що наряд зарезервував baseQty. Але резерв ставиться ЛИШЕ на APPROVED→IN_PROGRESS
 * (reserveParts). Шлях APPROVED→ON_HOLD→IN_PROGRESS→COMPLETED НЕ резервує, тож на COMPLETED
 * резерву наряду НЕМА. Безумовний RELEASE тоді кидає "cannotReleaseMoreThanReserved" у РЕАЛЬНОМУ
 * InventoryService (reserved на StockItem — агрегат, не per-document) → увесь перехід COMPLETED
 * падав; або звільняв ЧУЖИЙ резерв (псування лічильника).
 *
 * Тут inventory-мок ВІДТВОРЮЄ реальний guard (кидає коли |qty| > поточного reserved), щоб
 * юніт-тест ловив баг без живої БД. Фікс: writeOffPartsAndCharge рахує нетто-резерв НАРЯДУ з
 * його RESERVATION-рухів (stockMovement.findMany) і звільняє min(baseQty, свій_резерв).
 */

/**
 * Stateful inventory-мок, що дзеркалить InventoryService.createMovement:
 * RESERVATION_RELEASE кидає "cannotReleaseMoreThanReserved" коли |qty| > поточного reserved
 * (саме цей guard і ловить Bug #780), інакше зменшує лічильник. Спільний для обох Bug #780
 * describe-блоків — writeOff і release перевіряють ту саму інваріанту «не звільнити чужого».
 */
function makeStatefulInventory(initialReserved: number) {
  let reserved = initialReserved;
  const createMovement = vi
    .fn()
    .mockImplementation((_org: string, dto: { type: string; quantity: number }) => {
      if (dto.type === 'RESERVATION_RELEASE') {
        if (Math.abs(dto.quantity) > reserved) {
          return Promise.reject(new Error('cannotReleaseMoreThanReserved'));
        }
        reserved += dto.quantity; // quantity < 0 → зменшує reserved
        return Promise.resolve({ consumed: [], weightedCostPrice: null });
      }
      if (dto.type === 'RESERVATION') {
        reserved += dto.quantity;
        return Promise.resolve({ consumed: [], weightedCostPrice: null });
      }
      // WRITEOFF
      return Promise.resolve({ consumed: [{ batchId: 'b1' }], weightedCostPrice: 7 });
    });
  return { createMovement, getReserved: () => reserved };
}
describe('WorkOrderStockEffectsService.writeOffPartsAndCharge — Bug #780 (release лише свій резерв)', () => {
  function makeSvc(opts: {
    reservationMovements: Array<{ goodId: string; warehouseId: string; quantity: number }>;
    initialReserved: number;
    /** Рядки наряду; за замовчуванням один на 5 од. Перевизначається для multi-part сценаріїв. */
    parts?: Array<{ id: string; quantity: number }>;
  }) {
    const parts = opts.parts ?? [{ id: 'part-1', quantity: 5 }];
    const prisma = {
      workOrderPart: {
        findMany: vi.fn().mockResolvedValue(
          parts.map(p => ({
            id: p.id,
            goodId: GOOD_ID,
            warehouseId: WH_ID,
            quantity: p.quantity,
            unitOfMeasureId: null,
          })),
        ),
        update: vi.fn().mockResolvedValue({}),
      },
      workOrder: { findFirst: vi.fn().mockResolvedValue({ totalAmount: 500 }) },
      goodUoM: { findMany: vi.fn().mockResolvedValue([]) },
      stockMovement: { findMany: vi.fn().mockResolvedValue(opts.reservationMovements) },
    } as unknown as PrismaService;
    const inv = makeStatefulInventory(opts.initialReserved);
    const inventory = { createMovement: inv.createMovement } as unknown as InventoryService;
    const settlements = {
      createTransaction: vi.fn().mockResolvedValue({}),
    } as unknown as SettlementsService;
    return {
      svc: new WorkOrderStockEffectsService(prisma, inventory, settlements),
      createMovement: inv.createMovement,
      getReserved: inv.getReserved,
    };
  }

  it('ON_HOLD-шлях (резерву наряду немає) → COMPLETED НЕ падає, RELEASE пропускається', async () => {
    // Наряд пройшов APPROVED→ON_HOLD→IN_PROGRESS→COMPLETED: RESERVATION-рухів немає, reserved=0.
    const { svc, createMovement } = makeSvc({ reservationMovements: [], initialReserved: 0 });

    // Без фіксу: writeOff робить RESERVATION_RELEASE(-5) при reserved=0 → мок кидає → весь перехід падає.
    await expect(
      svc.writeOffPartsAndCharge(
        ORG,
        { id: 'wo-1', counterpartyId: 'cp-1', totalAmount: 500 as never },
        'user-1',
      ),
    ).resolves.toBeUndefined();

    const releaseCalls = createMovement.mock.calls.filter(c => c[1].type === 'RESERVATION_RELEASE');
    expect(releaseCalls).toHaveLength(0); // нема що звільняти → жодного RELEASE
    const writeoffCalls = createMovement.mock.calls.filter(c => c[1].type === 'WRITEOFF');
    expect(writeoffCalls).toHaveLength(1); // WRITEOFF усе одно відбувся
    expect(writeoffCalls[0][1].quantity).toBe(-5);
  });

  it('нормальний шлях (наряд зарезервував 5) → звільняє РІВНО 5, reserved→0', async () => {
    const { svc, createMovement, getReserved } = makeSvc({
      reservationMovements: [{ goodId: GOOD_ID, warehouseId: WH_ID, quantity: 5 }],
      initialReserved: 5,
    });

    await svc.writeOffPartsAndCharge(
      ORG,
      { id: 'wo-1', counterpartyId: 'cp-1', totalAmount: 500 as never },
      'user-1',
    );

    const releaseCalls = createMovement.mock.calls.filter(c => c[1].type === 'RESERVATION_RELEASE');
    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0][1].quantity).toBe(-5); // звільнено рівно свій резерв
    expect(getReserved()).toBe(0); // лічильник коректно обнулився
  });

  it('частковий резерв (наряд тримає 3, частина знята раніше) → звільняє min(baseQty=5, 3)=3, не underflow', async () => {
    // RESERVATION(+5) + RESERVATION_RELEASE(-2) раніше → нетто 3. baseQty=5, але свій резерв лише 3.
    const { svc, createMovement } = makeSvc({
      reservationMovements: [
        { goodId: GOOD_ID, warehouseId: WH_ID, quantity: 5 },
        { goodId: GOOD_ID, warehouseId: WH_ID, quantity: -2 },
      ],
      initialReserved: 3,
    });

    await expect(
      svc.writeOffPartsAndCharge(
        ORG,
        { id: 'wo-1', counterpartyId: 'cp-1', totalAmount: 500 as never },
        'user-1',
      ),
    ).resolves.toBeUndefined();

    const releaseCalls = createMovement.mock.calls.filter(c => c[1].type === 'RESERVATION_RELEASE');
    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0][1].quantity).toBe(-3); // не -5 → жодного underflow чужого резерву
  });

  it('два рядки на ОДИН (good,warehouse) → резерв ділиться між ними, без подвійного звільнення — MUTATION-VERIFY', async () => {
    // Резерв — агрегат по (good,warehouse), а не по рядку наряду. Наряд тримає 5, але має два
    // рядки по 4 на той самий товар+склад. Перший забирає 4, другому лишається 1.
    // MUTATION: прибрати декремент мапи у takeFromReserve → обидва рядки візьмуть по 4 (разом 8
    // при резерві 5) → другий RELEASE кине "cannotReleaseMoreThanReserved" і тест впаде.
    const { svc, createMovement, getReserved } = makeSvc({
      reservationMovements: [{ goodId: GOOD_ID, warehouseId: WH_ID, quantity: 5 }],
      initialReserved: 5,
      parts: [
        { id: 'part-1', quantity: 4 },
        { id: 'part-2', quantity: 4 },
      ],
    });

    await expect(
      svc.writeOffPartsAndCharge(
        ORG,
        { id: 'wo-1', counterpartyId: 'cp-1', totalAmount: 500 as never },
        'user-1',
      ),
    ).resolves.toBeUndefined();

    const releaseQtys = createMovement.mock.calls
      .filter(c => c[1].type === 'RESERVATION_RELEASE')
      .map(c => c[1].quantity);
    expect(releaseQtys).toEqual([-4, -1]); // разом рівно 5 — весь резерв наряду, не більше
    expect(getReserved()).toBe(0);
    // Обидва рядки все одно списані фізично (WRITEOFF не залежить від наявності резерву).
    const writeoffQtys = createMovement.mock.calls
      .filter(c => c[1].type === 'WRITEOFF')
      .map(c => c[1].quantity);
    expect(writeoffQtys).toEqual([-4, -4]);
  });
});

/**
 * Bug #780 (симетрія) — releasePartReservations мав ту саму ваду: безумовний RESERVATION_RELEASE
 * при скасуванні наряду, який резерву не тримав (шлях APPROVED→ON_HOLD→CANCELLED: reserveParts
 * спрацьовує лише на APPROVED→IN_PROGRESS). Реальний InventoryService кинув би
 * "cannotReleaseMoreThanReserved" → скасувати наряд неможливо.
 */
describe('WorkOrderStockEffectsService.releasePartReservations — Bug #780 (release лише свій резерв)', () => {
  function makeSvc(opts: {
    reservationMovements: Array<{ goodId: string; warehouseId: string; quantity: number }>;
    initialReserved: number;
  }) {
    const prisma = {
      workOrderPart: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'part-1',
            goodId: GOOD_ID,
            warehouseId: WH_ID,
            quantity: 7,
            unitOfMeasureId: null,
          },
        ]),
      },
      goodUoM: { findMany: vi.fn().mockResolvedValue([]) },
      stockMovement: { findMany: vi.fn().mockResolvedValue(opts.reservationMovements) },
    } as unknown as PrismaService;
    const inv = makeStatefulInventory(opts.initialReserved);
    const inventory = { createMovement: inv.createMovement } as unknown as InventoryService;
    const settlements = { createTransaction: vi.fn() } as unknown as SettlementsService;
    return {
      svc: new WorkOrderStockEffectsService(prisma, inventory, settlements),
      createMovement: inv.createMovement,
    };
  }

  it('ON_HOLD-шлях (резерву немає) → CANCELLED НЕ падає, RELEASE пропускається', async () => {
    const { svc, createMovement } = makeSvc({ reservationMovements: [], initialReserved: 0 });
    await expect(svc.releasePartReservations(ORG, 'wo-1', 'user-1')).resolves.toBeUndefined();
    expect(createMovement.mock.calls.filter(c => c[1].type === 'RESERVATION_RELEASE')).toHaveLength(
      0,
    );
  });

  it('нормальний шлях (зарезервовано 7) → звільняє рівно 7', async () => {
    const { svc, createMovement } = makeSvc({
      reservationMovements: [{ goodId: GOOD_ID, warehouseId: WH_ID, quantity: 7 }],
      initialReserved: 7,
    });
    await svc.releasePartReservations(ORG, 'wo-1', 'user-1');
    const rel = createMovement.mock.calls.filter(c => c[1].type === 'RESERVATION_RELEASE');
    expect(rel).toHaveLength(1);
    expect(rel[0][1].quantity).toBe(-7);
  });
});
