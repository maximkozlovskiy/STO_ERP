/**
 * InventoryService.createMovement — guards і tenant-ізоляція
 *
 * Виділено з `inventory.service.spec.ts` (був 983 рядки, 4 незалежні top-level
 * describe) 2026-10-06. Кейси перенесені ДОСЛІВНО, назви describe не змінені —
 * інакше `fullName` у test-baseline.json розійшовся б.
 */

import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { InventoryService } from './inventory.service';
import { BatchService } from './batch.service';
import { SettingsService } from '../settings/settings.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('InventoryService.createMovement guards', () => {
  let service: InventoryService;
  let prisma: {
    stockItem: { findFirst: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
    stockMovement: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    batchConsumption: { findMany: ReturnType<typeof vi.fn> };
    good: { findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let batchService: {
    createFromReceipt: ReturnType<typeof vi.fn>;
    consumeBatch: ReturnType<typeof vi.fn>;
    getAvgCost: ReturnType<typeof vi.fn>;
    returnToBatch: ReturnType<typeof vi.fn>;
  };
  let settingsService: { getOrganisationSettings: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      // Bug #613: upsert selects { quantity, reserved } for post-check guard.
      // Дефолтний повернення — валідні ненегативні (щоб happy-path не тригерив throw).
      stockItem: {
        findFirst: vi.fn(),
        upsert: vi.fn().mockResolvedValue({ quantity: 100, reserved: 0 }),
      },
      stockMovement: {
        create: vi.fn().mockResolvedValue({ id: 'mov-1' }),
        update: vi.fn().mockResolvedValue({}),
      },
      batchConsumption: { findMany: vi.fn().mockResolvedValue([]) },
      good: { findFirst: vi.fn().mockResolvedValue({ purchasePrice: null }) },
      // Bug #613 no-tx self-wrap: createMovement без tx re-enter через $transaction.
      // Passthrough — callback дістає той самий мок (той самий tx-контекст у тесті).
      $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
    };
    batchService = {
      createFromReceipt: vi.fn().mockResolvedValue({}),
      consumeBatch: vi.fn().mockResolvedValue([]),
      getAvgCost: vi.fn().mockResolvedValue(0),
      returnToBatch: vi.fn().mockResolvedValue(undefined),
    };
    settingsService = {
      getOrganisationSettings: vi.fn().mockResolvedValue({ costMethod: 'FIFO' }),
    };
    const module = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        { provide: BatchService, useValue: batchService },
        { provide: SettingsService, useValue: settingsService },
      ],
    }).compile();
    service = module.get(InventoryService);
  });

  const dto = (overrides: Partial<Parameters<InventoryService['createMovement']>[1]> = {}) => ({
    goodId: 'good-1',
    warehouseId: 'wh-1',
    type: 'RECEIPT' as const,
    quantity: 10,
    ...overrides,
  });

  // guards: BR-INVT-002
  it('кидає при quantity = 0', async () => {
    await expect(service.createMovement('org-1', dto({ quantity: 0 }))).rejects.toThrow(
      BadRequestException,
    );
  });

  it('кидає при RESERVATION_RELEASE з positive quantity', async () => {
    await expect(
      service.createMovement('org-1', dto({ type: 'RESERVATION_RELEASE', quantity: 5 })),
    ).rejects.toThrow(BadRequestException);
  });

  // guards: BR-INVT-003
  it('кидає при WRITEOFF якщо available < |quantity|', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 5, reserved: 0 });
    await expect(
      service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -10 })),
    ).rejects.toThrow(BadRequestException);
  });

  // guards: BR-INVT-005
  it('кидає при RESERVATION якщо available < quantity', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 10, reserved: 8 });
    await expect(
      service.createMovement('org-1', dto({ type: 'RESERVATION', quantity: 5 })),
    ).rejects.toThrow(BadRequestException);
  });

  // guards: BR-INVT-005
  it('кидає при RESERVATION_RELEASE якщо |quantity| > reserved', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 10, reserved: 2 });
    await expect(
      service.createMovement('org-1', dto({ type: 'RESERVATION_RELEASE', quantity: -5 })),
    ).rejects.toThrow(BadRequestException);
  });

  // CRITICAL (audit 2026-09-04): OPENING_BALANCE збільшує quantity, тож МУСИТЬ створити партію —
  // інакше Σ remainingQty=0 при quantity>0 → товар несписуваний («Недостатньо партій»). Початкові
  // залишки (міграція даних при впровадженні) — типовий сценарій; раніше партія не створювалась.
  // guards: BR-INVT-008
  it('OPENING_BALANCE створює партію (як RECEIPT), інакше залишок несписуваний', async () => {
    await service.createMovement(
      'org-1',
      dto({ type: 'OPENING_BALANCE', quantity: 100, price: 50 }),
    );
    expect(batchService.createFromReceipt).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ goodId: 'good-1', receivedQty: 100, costPrice: 50 }),
      expect.anything(),
    );
  });

  // guards: BR-INVT-008
  it('OPENING_BALANCE без price → fallback до good.purchasePrice (партія створюється)', async () => {
    prisma.good.findFirst.mockResolvedValue({ purchasePrice: 42 });
    await service.createMovement('org-1', dto({ type: 'OPENING_BALANCE', quantity: 100 }));
    expect(batchService.createFromReceipt).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ receivedQty: 100, costPrice: 42 }),
      expect.anything(),
    );
  });

  // MEDIUM (audit 2026-09-04): симетричний race-guard проти НАД-резервування. Два concurrent
  // RESERVATION проходять stale pre-check; post-check row-locked reserved>quantity → throw.
  // guards: BR-INVT-006
  it('over-reservation guard: upsert віддає reserved > quantity → throw (concurrent RESERVATION)', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 10, reserved: 0 }); // pre-check пройде
    prisma.stockItem.upsert.mockResolvedValue({ quantity: 10, reserved: 20 }); // race: reserved>quantity
    await expect(
      service.createMovement('org-1', dto({ type: 'RESERVATION', quantity: 10 })),
    ).rejects.toThrow(BadRequestException);
  });

  // Pre-prod audit R2: WRITEOFF, що опускає quantity НИЖЧЕ reserved (пряме списання без RELEASE),
  // раніше не ловилось (reserved>quantity guard був лише на reservedDelta>0). Тепер throw і на
  // quantityDelta<0 → available не стане від'ємним при обох полях ≥0.
  // guards: BR-INVT-006
  it("WRITEOFF опускає quantity нижче reserved → throw (available не від'ємний)", async () => {
    // pre-check бачить reserved=0 → available=20 ≥ 8, WRITEOFF проходить pre-check.
    prisma.stockItem.findFirst.mockResolvedValueOnce({ quantity: 20, reserved: 0 });
    // Race: між pre-check і upsert concurrent RESERVATION підняв reserved=15. Row-locked upsert →
    // quantity=12 (20−8), reserved=15 → reserved>quantity (available=-3). Post-check ловить.
    prisma.stockItem.upsert.mockResolvedValue({ quantity: 12, reserved: 15 });
    await expect(
      service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -8 })),
    ).rejects.toThrow(/нижче зарезервованого/);
  });

  // Bug #613 (cycle 2 code-review): виклик без tx має самообгортатись у $transaction,
  // щоб throw (race/нестача) не лишив orphan-записів (StockMovement/StockItem/BatchConsumption).
  // guards: BR-INVT-007
  it('createMovement без tx re-enter через $transaction (атомарність)', async () => {
    await service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 10, price: 50 }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  // guards: BR-INVT-007
  it('createMovement з tx НЕ обгортається повторно у $transaction', async () => {
    await service.createMovement(
      'org-1',
      dto({ type: 'RECEIPT', quantity: 10, price: 50 }),
      prisma as never,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('RECEIPT збільшує quantity і не торкається reserved', async () => {
    await service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 10, price: 50 }));
    expect(prisma.stockMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'RECEIPT', quantity: 10 }),
    });
    expect(prisma.stockItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          quantity: { increment: 10 },
          reserved: { increment: 0 },
        }),
      }),
    );
  });

  // guards: BR-INVT-008
  it('Bug #26: RECEIPT без price fallback до good.purchasePrice', async () => {
    prisma.good.findFirst.mockResolvedValue({ purchasePrice: 42 });
    await service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 10 }));
    expect(batchService.createFromReceipt).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ receivedQty: 10, costPrice: 42 }),
      expect.anything(),
    );
  });

  // guards: BR-INVT-008
  it('Bug #26: RECEIPT без price і без purchasePrice → costPrice=0', async () => {
    prisma.good.findFirst.mockResolvedValue({ purchasePrice: null });
    await service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 10 }));
    expect(batchService.createFromReceipt).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ receivedQty: 10, costPrice: 0 }),
      expect.anything(),
    );
  });

  // guards: BR-INVT-008
  it('Bug #15: RECEIPT з price=0 (безкоштовний зразок) створює партію з нульовою собівартістю', async () => {
    await service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 5, price: 0 }));
    expect(prisma.stockMovement.create).toHaveBeenCalled();
    expect(batchService.createFromReceipt).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ receivedQty: 5, costPrice: 0 }),
      expect.anything(),
    );
  });

  // guards: BR-INVT-002
  it('Bug #26: createMovement кидає при NaN quantity', async () => {
    await expect(
      service.createMovement('org-1', dto({ quantity: NaN, price: 50 })),
    ).rejects.toThrow(BadRequestException);
  });

  // guards: BR-INVT-002
  it('Bug #26: createMovement кидає при NaN price', async () => {
    await expect(
      service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 5, price: NaN })),
    ).rejects.toThrow(BadRequestException);
  });

  // guards: BR-INVT-004
  it('RESERVATION тільки інкрементує reserved, не quantity', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 100, reserved: 0 });
    await service.createMovement('org-1', dto({ type: 'RESERVATION', quantity: 5 }));
    expect(prisma.stockItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          quantity: { increment: 0 },
          reserved: { increment: 5 },
        }),
      }),
    );
  });

  it('WRITEOFF з достатніми залишками декрементує quantity', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 100, reserved: 0 });
    await service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -10 }));
    expect(prisma.stockItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          quantity: { increment: -10 },
          reserved: { increment: 0 },
        }),
      }),
    );
  });

  // CRITICAL (audit 2026-09-04): Prisma upsert компілюється у `INSERT ... VALUES (quantity)
  // ON CONFLICT DO UPDATE`. Postgres перевіряє CHECK stock_items_quantity_nonneg на INSERT-tuple
  // ДО арбітражу конфлікту → від'ємний create.quantity валив 23514 (500) на КОЖНОМУ WRITEOFF/
  // TRANSFER-out/WO-COMPLETED, НАВІТЬ коли рядок існує і DO UPDATE дав би коректний залишок.
  // Guard: create.quantity МУСИТЬ бути кламповане до ≥0 (як reserved). Мок не б'є Postgres,
  // тож асертимо саме payload create-гілки — рефактор який зніме Math.max впаде тут.
  it('WRITEOFF: create-гілка upsert клампить quantity до ≥0 (Postgres CHECK vs ON CONFLICT)', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 100, reserved: 0 });
    await service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -40 }));
    const call = prisma.stockItem.upsert.mock.calls[0]![0] as {
      create: { quantity: number; reserved: number };
      update: { quantity: { increment: number } };
    };
    // create-гілка (виконується лише коли рядка нема) — quantity НЕ від'ємна
    expect(call.create.quantity).toBe(0);
    expect(call.create.quantity).toBeGreaterThanOrEqual(0);
    // update-гілка (existing row) все одно декрементує на реальну дельту
    expect(call.update.quantity).toEqual({ increment: -40 });
  });

  // Партійне списання (COGS) — головний фікс: WRITEOFF викликає consumeBatch з costMethod
  // з налаштувань і повертає зважену собівартість.
  // guards: BR-INVT-009
  it('WRITEOFF викликає consumeBatch з costMethod із налаштувань + повертає weightedCostPrice', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 100, reserved: 0 });
    settingsService.getOrganisationSettings.mockResolvedValue({ costMethod: 'FIFO' });
    // FIFO span: 10×100 + 5×120 = 1600 → weighted 106.67
    batchService.consumeBatch.mockResolvedValue([
      { batchId: 'b1', quantity: 10, costPrice: 100 },
      { batchId: 'b2', quantity: 5, costPrice: 120 },
    ]);
    const res = await service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -15 }));
    expect(batchService.consumeBatch).toHaveBeenCalledWith(
      'org-1',
      'good-1',
      'wh-1',
      15,
      expect.anything(),
      expect.anything(),
      undefined,
      'FIFO',
      expect.anything(),
    );
    expect(res.weightedCostPrice).toBeCloseTo(1600 / 15, 5);
    expect(res.consumed).toHaveLength(2);
    // batchId у рух НЕ проставляється при span (2 партії)
    expect(prisma.stockMovement.update).not.toHaveBeenCalled();
  });

  // guards: BR-INVT-016
  it('WRITEOFF single-batch → проставляє batchId у stockMovement', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 100, reserved: 0 });
    batchService.consumeBatch.mockResolvedValue([{ batchId: 'b1', quantity: 5, costPrice: 100 }]);
    const res = await service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -5 }));
    expect(res.weightedCostPrice).toBe(100);
    expect(prisma.stockMovement.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { batchId: 'b1' } }),
    );
  });

  // guards: BR-INVT-010
  it('AVG_COST: weightedCostPrice = getAvgCost, партії все одно списуються FIFO (інваріант)', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 100, reserved: 0 });
    settingsService.getOrganisationSettings.mockResolvedValue({ costMethod: 'AVG_COST' });
    batchService.getAvgCost.mockResolvedValue(110);
    batchService.consumeBatch.mockResolvedValue([{ batchId: 'b1', quantity: 5, costPrice: 100 }]);
    const res = await service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -5 }));
    expect(res.weightedCostPrice).toBe(110); // з getAvgCost, не з партій
    // фізичний декремент партій — FIFO (щоб remainingQty спадав)
    expect(batchService.consumeBatch).toHaveBeenCalledWith(
      'org-1',
      'good-1',
      'wh-1',
      5,
      expect.anything(),
      expect.anything(),
      undefined,
      'FIFO',
      expect.anything(),
    );
  });

  // guards: BR-INVT-009
  it('RECEIPT НЕ викликає consumeBatch (лише розхід списує партії)', async () => {
    await service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 10, price: 100 }));
    expect(batchService.consumeBatch).not.toHaveBeenCalled();
  });

  // Regression-guard: AVG_COST branch у BatchService.consumeBatch повертає агрегат
  // {batchId: null, quantity, costPrice: avgCost} (не одна конкретна партія).
  // `const singleBatchId = consumed.length===1 ? consumed[0].batchId : null; if (singleBatchId)`
  // → update пропускається, коли batchId===null (порожній рядок раніше пробивав
  // StockMovement.batchId :: uuid → "invalid input syntax for type uuid").
  it('AVG_COST агрегат batchId=null НЕ викликає stockMovement.update (uuid guard)', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 100, reserved: 0 });
    settingsService.getOrganisationSettings.mockResolvedValue({ costMethod: 'AVG_COST' });
    batchService.getAvgCost.mockResolvedValue(110);
    // AVG_COST branch повертає [{batchId: null, ...}] — дзеркалимо реальний контракт.
    batchService.consumeBatch.mockResolvedValue([{ batchId: null, quantity: 5, costPrice: 110 }]);
    await service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -5 }));
    expect(prisma.stockMovement.update).not.toHaveBeenCalled();
  });

  // Pre-check рахує від ДОСТУПНОГО (quantity − reserved), не від фізичного залишку: інакше
  // пряме списання «з'їло» б чужий резерв. Тут фізично є 10, але 8 зарезервовано → доступно 2.
  // guards: BR-INVT-003
  it('WRITEOFF у межах quantity, але понад available (частину зарезервовано) → 400, рух не записано', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 10, reserved: 8 });
    await expect(
      service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -5 })),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(prisma.stockItem.upsert).not.toHaveBeenCalled();
  });

  // guards: BR-INVT-004
  it('RESERVATION_RELEASE зменшує лише reserved: quantity не змінюється, партії не списуються', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 10, reserved: 5 });
    prisma.stockItem.upsert.mockResolvedValue({ quantity: 10, reserved: 0 });
    await service.createMovement('org-1', dto({ type: 'RESERVATION_RELEASE', quantity: -5 }));
    expect(prisma.stockItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          quantity: { increment: 0 },
          reserved: { increment: -5 },
        }),
      }),
    );
    expect(batchService.consumeBatch).not.toHaveBeenCalled();
    expect(batchService.createFromReceipt).not.toHaveBeenCalled();
  });

  // Сусідній кейс вище ставить costMethod='FIFO' — те саме, що й fallback, тож «метод узято з
  // налаштувань» він не доводить. LIFO відрізняється від fallback: якщо метод захардкодити, впаде.
  // guards: BR-INVT-009
  it('WRITEOFF: costMethod=LIFO з налаштувань доходить до consumeBatch без підміни', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 100, reserved: 0 });
    settingsService.getOrganisationSettings.mockResolvedValue({ costMethod: 'LIFO' });
    await service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -5 }));
    expect(settingsService.getOrganisationSettings).toHaveBeenCalledWith('org-1');
    expect(batchService.consumeBatch).toHaveBeenCalledTimes(1);
    expect(batchService.consumeBatch.mock.calls[0]![7]).toBe('LIFO');
  });

  // guards: BR-INVT-009
  it('WRITEOFF: costMethod не задано або налаштування недоступні → FIFO', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 100, reserved: 0 });
    settingsService.getOrganisationSettings.mockResolvedValueOnce({ costMethod: null });
    await service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -5 }));
    expect(batchService.consumeBatch.mock.calls[0]![7]).toBe('FIFO');

    settingsService.getOrganisationSettings.mockRejectedValueOnce(new Error('redis down'));
    await service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -5 }));
    expect(batchService.consumeBatch.mock.calls[1]![7]).toBe('FIFO');
  });

  // Середня рахується по партіях ДО списання: після FIFO-декременту найстаріші (зазвичай
  // дешевші) партії вже зменшені, і та сама формула дала б іншу собівартість.
  // guards: BR-INVT-010
  it('AVG_COST: getAvgCost викликається ДО consumeBatch (середня до списання)', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 100, reserved: 0 });
    settingsService.getOrganisationSettings.mockResolvedValue({ costMethod: 'AVG_COST' });
    batchService.getAvgCost.mockResolvedValue(110);
    batchService.consumeBatch.mockResolvedValue([{ batchId: 'b1', quantity: 5, costPrice: 100 }]);
    await service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -5 }));
    expect(batchService.getAvgCost).toHaveBeenCalledTimes(1);
    expect(batchService.getAvgCost.mock.invocationCallOrder[0]!).toBeLessThan(
      batchService.consumeBatch.mock.invocationCallOrder[0]!,
    );
  });

  // Сусідній кейс «RESERVATION_RELEASE з positive quantity» не задає залишку, тож його 400 дає
  // сусідній guard «знімаєш більше, ніж зарезервовано». Тут резерву достатньо: без перевірки
  // знака додатний RELEASE збільшив би reserved в обхід перевірки available.
  // guards: BR-INVT-005
  it('RESERVATION_RELEASE з додатною кількістю → 400 навіть коли резерву достатньо', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 20, reserved: 10 });
    await expect(
      service.createMovement('org-1', dto({ type: 'RESERVATION_RELEASE', quantity: 5 })),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
  });

  // Bug #238: defense-in-depth tenant guard for caller-supplied unitOfMeasureId
  describe('Bug #238: unitOfMeasureId tenant guard', () => {
    const OWN_UOM = '11111111-1111-4111-8111-111111111111';
    const CROSS_UOM = '22222222-2222-4222-8222-222222222222';

    beforeEach(() => {
      // Extend prisma mock with unitOfMeasure.findFirst (was missing in base setup)
      (
        prisma as unknown as { unitOfMeasure: { findFirst: ReturnType<typeof vi.fn> } }
      ).unitOfMeasure = { findFirst: vi.fn() };
    });

    // guards: BR-INVT-017
    it('cross-tenant unitOfMeasureId → BadRequestException, stockMovement.create НЕ викликаний', async () => {
      (
        prisma as unknown as { unitOfMeasure: { findFirst: ReturnType<typeof vi.fn> } }
      ).unitOfMeasure.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.createMovement(
          'org-1',
          dto({ type: 'RECEIPT', quantity: 10, price: 50, unitOfMeasureId: CROSS_UOM }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(prisma.stockItem.upsert).not.toHaveBeenCalled();
    });

    it('own-org unitOfMeasureId → проходить + записує у stockMovement.create', async () => {
      (
        prisma as unknown as { unitOfMeasure: { findFirst: ReturnType<typeof vi.fn> } }
      ).unitOfMeasure.findFirst.mockResolvedValueOnce({ id: OWN_UOM });
      await service.createMovement(
        'org-1',
        dto({ type: 'RECEIPT', quantity: 10, price: 50, unitOfMeasureId: OWN_UOM }),
      );
      expect(prisma.stockMovement.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ unitOfMeasureId: OWN_UOM }),
      });
    });

    it('unitOfMeasureId не передано → findFirst НЕ викликаний (skip guard)', async () => {
      await service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 10, price: 50 }));
      expect(
        (prisma as unknown as { unitOfMeasure: { findFirst: ReturnType<typeof vi.fn> } })
          .unitOfMeasure.findFirst,
      ).not.toHaveBeenCalled();
      expect(prisma.stockMovement.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ unitOfMeasureId: null }),
      });
    });
  });

  // ─── Bug #613 — post-upsert race-condition guards ──────────────────────────
  // Regression-guard для defensive-checks у createMovement (Bug #613): pre-check
  // available>=|qty| читає STALE snapshot без row-lock — два concurrent WRITEOFF
  // того самого товару обидва проходять pre-check, потім Postgres serialize upsert
  // рядково → другий залишає quantity=-N. Post-check ПІСЛЯ upsert ловить негатив і
  // throws → $transaction rollback. Без guard: silent quantity<0 у StockItem.
  describe('Bug #613 — concurrent WRITEOFF race-condition guard', () => {
    // guards: BR-INVT-006
    it('WRITEOFF з concurrent race (upsert повернув quantity<0) → BadRequestException', async () => {
      prisma.stockItem.findFirst.mockResolvedValue({ quantity: 10, reserved: 0 });
      // Симулюємо race: pre-check бачить 10, але між pre-check і upsert інший tx
      // задекрементив до 0, і наш decrement -10 записав -10 у row-lock послідовності.
      prisma.stockItem.upsert.mockResolvedValueOnce({ quantity: -10, reserved: 0 });
      await expect(
        service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -10 })),
      ).rejects.toThrow(/Недостатньо товару.*concurrent/i);
    });

    // guards: BR-INVT-006
    it('RESERVATION_RELEASE з concurrent race (reserved<0 після upsert) → BadRequestException', async () => {
      prisma.stockItem.findFirst.mockResolvedValue({ quantity: 10, reserved: 5 });
      prisma.stockItem.upsert.mockResolvedValueOnce({ quantity: 10, reserved: -1 });
      await expect(
        service.createMovement('org-1', dto({ type: 'RESERVATION_RELEASE', quantity: -5 })),
      ).rejects.toThrow(/Резерв не може стати від/i);
    });

    it('happy-path (upsert повернув quantity>=0, reserved>=0) → без throw', async () => {
      prisma.stockItem.findFirst.mockResolvedValue({ quantity: 10, reserved: 0 });
      prisma.stockItem.upsert.mockResolvedValueOnce({ quantity: 0, reserved: 0 });
      batchService.consumeBatch.mockResolvedValueOnce([
        { batchId: 'b1', quantity: 10, costPrice: 50 },
      ]);
      await expect(
        service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -10 })),
      ).resolves.toBeDefined();
    });
  });

  // ─── RETURN branch (C2) — реверс WRITEOFF ─────────────────────────────────
  describe('RETURN — повернення на склад (реверс WRITEOFF)', () => {
    const retDto = (overrides = {}) => ({
      goodId: 'good-1',
      warehouseId: 'wh-1',
      type: 'RETURN' as const,
      quantity: 3,
      documentType: 'WorkOrder',
      documentId: 'wo-1',
      ...overrides,
    });

    // guards: BR-INVT-014
    it('позитивна к-сть інкрементує StockItem.quantity і НЕ створює нову партію', async () => {
      await service.createMovement('org-1', retDto());
      // StockItem upsert з increment: +3 (не batch-creating)
      const upsertCall = prisma.stockItem.upsert.mock.calls[0][0];
      expect(upsertCall.update.quantity).toEqual({ increment: 3 });
      expect(batchService.createFromReceipt).not.toHaveBeenCalled();
    });

    // guards: BR-INVT-014
    it('шукає негативні BatchConsumption документа й повертає у КОЖНУ партію', async () => {
      prisma.batchConsumption.findMany.mockResolvedValue([
        { batchId: 'b1', quantity: -2 },
        { batchId: 'b2', quantity: -1 },
      ]);
      await service.createMovement('org-1', retDto({ quantity: 3 }));
      // findMany фільтрує по (documentType, documentId, quantity<0)
      const where = prisma.batchConsumption.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        orgId: 'org-1',
        documentType: 'WorkOrder',
        documentId: 'wo-1',
        quantity: { lt: 0 },
      });
      // returnToBatch на кожну партію з abs(quantity)
      expect(batchService.returnToBatch).toHaveBeenCalledTimes(2);
      expect(batchService.returnToBatch).toHaveBeenCalledWith(
        'org-1',
        'b1',
        2,
        'WorkOrder',
        'wo-1',
        expect.anything(),
      );
      expect(batchService.returnToBatch).toHaveBeenCalledWith(
        'org-1',
        'b2',
        1,
        'WorkOrder',
        'wo-1',
        expect.anything(),
      );
    });

    // guards: BR-INVT-014
    it('shared-batch: дві частини з ОДНІЄЇ партії → ОДИН агрегований returnToBatch (per-line hazard)', async () => {
      // Дві негативні consumption на b1 (різні documentLineId) → агрегуються у 2+3=5.
      prisma.batchConsumption.findMany.mockResolvedValue([
        { batchId: 'b1', quantity: -2 },
        { batchId: 'b1', quantity: -3 },
      ]);
      await service.createMovement('org-1', retDto({ quantity: 5 }));
      expect(batchService.returnToBatch).toHaveBeenCalledTimes(1);
      expect(batchService.returnToBatch).toHaveBeenCalledWith(
        'org-1',
        'b1',
        5, // 2+3 агреговано — інакше 2-й виклик тихо пропустив би idempotency-guard
        'WorkOrder',
        'wo-1',
        expect.anything(),
      );
    });

    it('0 негативних consumption (AVG_COST / без партій) → StockItem++, returnToBatch НЕ викликається, без throw', async () => {
      prisma.batchConsumption.findMany.mockResolvedValue([]);
      await expect(service.createMovement('org-1', retDto())).resolves.toBeDefined();
      expect(prisma.stockItem.upsert).toHaveBeenCalled(); // залишок відновлено
      expect(batchService.returnToBatch).not.toHaveBeenCalled();
    });

    // guards: BR-INVT-014
    it('RETURN без documentType/documentId → BadRequest (нема як знайти джерело)', async () => {
      await expect(
        service.createMovement('org-1', retDto({ documentType: undefined })),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createMovement('org-1', retDto({ documentId: undefined })),
      ).rejects.toThrow(BadRequestException);
    });

    it("RETURN з від'ємною к-стю → BadRequest", async () => {
      await expect(service.createMovement('org-1', retDto({ quantity: -3 }))).rejects.toThrow(
        BadRequestException,
      );
    });

    // Кейс вище не задає залишку — без перевірки знака його 400 дав би guard «недостатньо товару».
    // Тут товару достатньо: без перевірки знака від'ємний RETURN став би звичайним списанням.
    // guards: BR-INVT-014
    it("RETURN з від'ємною к-стю → 400 навіть за достатнього залишку (не стає списанням)", async () => {
      prisma.stockItem.findFirst.mockResolvedValue({ quantity: 10, reserved: 0 });
      await expect(service.createMovement('org-1', retDto({ quantity: -3 }))).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(batchService.consumeBatch).not.toHaveBeenCalled();
    });
  });
});
