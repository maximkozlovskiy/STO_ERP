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
    good: { findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let batchService: {
    createFromReceipt: ReturnType<typeof vi.fn>;
    consumeBatch: ReturnType<typeof vi.fn>;
    getAvgCost: ReturnType<typeof vi.fn>;
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
      good: { findFirst: vi.fn().mockResolvedValue({ purchasePrice: null }) },
      // Bug #613 no-tx self-wrap: createMovement без tx re-enter через $transaction.
      // Passthrough — callback дістає той самий мок (той самий tx-контекст у тесті).
      $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
    };
    batchService = {
      createFromReceipt: vi.fn().mockResolvedValue({}),
      consumeBatch: vi.fn().mockResolvedValue([]),
      getAvgCost: vi.fn().mockResolvedValue(0),
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

  it('кидає при WRITEOFF якщо available < |quantity|', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 5, reserved: 0 });
    await expect(
      service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -10 })),
    ).rejects.toThrow(BadRequestException);
  });

  it('кидає при RESERVATION якщо available < quantity', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 10, reserved: 8 });
    await expect(
      service.createMovement('org-1', dto({ type: 'RESERVATION', quantity: 5 })),
    ).rejects.toThrow(BadRequestException);
  });

  it('кидає при RESERVATION_RELEASE якщо |quantity| > reserved', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 10, reserved: 2 });
    await expect(
      service.createMovement('org-1', dto({ type: 'RESERVATION_RELEASE', quantity: -5 })),
    ).rejects.toThrow(BadRequestException);
  });

  // Bug #613 (cycle 2 code-review): виклик без tx має самообгортатись у $transaction,
  // щоб throw (race/нестача) не лишив orphan-записів (StockMovement/StockItem/BatchConsumption).
  it('createMovement без tx re-enter через $transaction (атомарність)', async () => {
    await service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 10, price: 50 }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

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

  it('Bug #26: RECEIPT без price fallback до good.purchasePrice', async () => {
    prisma.good.findFirst.mockResolvedValue({ purchasePrice: 42 });
    await service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 10 }));
    expect(batchService.createFromReceipt).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ receivedQty: 10, costPrice: 42 }),
      expect.anything(),
    );
  });

  it('Bug #26: RECEIPT без price і без purchasePrice → costPrice=0', async () => {
    prisma.good.findFirst.mockResolvedValue({ purchasePrice: null });
    await service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 10 }));
    expect(batchService.createFromReceipt).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ receivedQty: 10, costPrice: 0 }),
      expect.anything(),
    );
  });

  it('Bug #15: RECEIPT з price=0 (безкоштовний зразок) створює партію з нульовою собівартістю', async () => {
    await service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 5, price: 0 }));
    expect(prisma.stockMovement.create).toHaveBeenCalled();
    expect(batchService.createFromReceipt).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ receivedQty: 5, costPrice: 0 }),
      expect.anything(),
    );
  });

  it('Bug #26: createMovement кидає при NaN quantity', async () => {
    await expect(
      service.createMovement('org-1', dto({ quantity: NaN, price: 50 })),
    ).rejects.toThrow(BadRequestException);
  });

  it('Bug #26: createMovement кидає при NaN price', async () => {
    await expect(
      service.createMovement('org-1', dto({ type: 'RECEIPT', quantity: 5, price: NaN })),
    ).rejects.toThrow(BadRequestException);
  });

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

  // Партійне списання (COGS) — головний фікс: WRITEOFF викликає consumeBatch з costMethod
  // з налаштувань і повертає зважену собівартість.
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

  it('WRITEOFF single-batch → проставляє batchId у stockMovement', async () => {
    prisma.stockItem.findFirst.mockResolvedValue({ quantity: 100, reserved: 0 });
    batchService.consumeBatch.mockResolvedValue([{ batchId: 'b1', quantity: 5, costPrice: 100 }]);
    const res = await service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -5 }));
    expect(res.weightedCostPrice).toBe(100);
    expect(prisma.stockMovement.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { batchId: 'b1' } }),
    );
  });

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
    it('WRITEOFF з concurrent race (upsert повернув quantity<0) → BadRequestException', async () => {
      prisma.stockItem.findFirst.mockResolvedValue({ quantity: 10, reserved: 0 });
      // Симулюємо race: pre-check бачить 10, але між pre-check і upsert інший tx
      // задекрементив до 0, і наш decrement -10 записав -10 у row-lock послідовності.
      prisma.stockItem.upsert.mockResolvedValueOnce({ quantity: -10, reserved: 0 });
      await expect(
        service.createMovement('org-1', dto({ type: 'WRITEOFF', quantity: -10 })),
      ).rejects.toThrow(/Недостатньо товару.*concurrent/i);
    });

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
});

// ─── Bug #455: byDocument() / byBatch() unit specs ────────────────────────────
// Регресія-guard для 3-view stock report (commit a5f01d37 + fixes 1752a753).
// Покриває: tenant isolation, soft-delete relation-filter, групування, мульти-
// warehouse SUM, з/без покази документів, конверсія Decimal→Number, date range.

describe('InventoryService.byDocument()', () => {
  let service: InventoryService;
  let prisma: {
    stockItem: { findMany: ReturnType<typeof vi.fn> };
    stockMovement: { findMany: ReturnType<typeof vi.fn> };
    stockBatch: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    prisma = {
      stockItem: { findMany: vi.fn().mockResolvedValue([]) },
      stockMovement: { findMany: vi.fn().mockResolvedValue([]) },
      stockBatch: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const module = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        { provide: BatchService, useValue: { createFromReceipt: vi.fn() } },
        {
          provide: SettingsService,
          useValue: { getOrganisationSettings: vi.fn().mockResolvedValue({ costMethod: 'FIFO' }) },
        },
      ],
    }).compile();
    service = module.get(InventoryService);
  });

  it('повертає `{ goods: [] }` коли немає stockItems', async () => {
    const result = await service.byDocument('org-1');
    expect(result).toEqual({ goods: [] });
  });

  it('передає orgId і soft-delete фільтри у обидва Prisma запити', async () => {
    await service.byDocument('org-1');
    expect(prisma.stockItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: 'org-1',
          deletedAt: null,
          good: { deletedAt: null },
          warehouse: { deletedAt: null },
        }),
      }),
    );
    expect(prisma.stockMovement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: 'org-1',
          good: { deletedAt: null },
          warehouse: { deletedAt: null },
        }),
      }),
    );
  });

  it('передає warehouseId/goodId у where коли вказані', async () => {
    await service.byDocument('org-1', 'wh-1', 'good-1');
    expect(prisma.stockItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ warehouseId: 'wh-1', goodId: 'good-1' }),
      }),
    );
    expect(prisma.stockMovement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ warehouseId: 'wh-1', goodId: 'good-1' }),
      }),
    );
  });

  it('агрегує quantity по мульти-warehouse stockItems одного good', async () => {
    prisma.stockItem.findMany.mockResolvedValueOnce([
      {
        goodId: 'good-1',
        quantity: 10,
        good: { name: 'A', sku: 'A1', unit: 'шт', brand: null },
        warehouse: { name: 'wh1' },
      },
      {
        goodId: 'good-1',
        quantity: 25,
        good: { name: 'A', sku: 'A1', unit: 'шт', brand: null },
        warehouse: { name: 'wh2' },
      },
    ]);
    const result = await service.byDocument('org-1');
    expect(result.goods).toHaveLength(1);
    expect(result.goods[0].totalQuantity).toBe(35);
  });

  it('групує movements по documentType::documentId у `documents[]`', async () => {
    prisma.stockItem.findMany.mockResolvedValueOnce([
      {
        goodId: 'good-1',
        quantity: 10,
        good: { name: 'A', sku: null, unit: 'шт', brand: null },
        warehouse: { name: 'wh1' },
      },
    ]);
    prisma.stockMovement.findMany.mockResolvedValueOnce([
      {
        goodId: 'good-1',
        type: 'RECEIPT',
        quantity: 5,
        createdAt: new Date('2025-01-15'),
        documentType: 'PurchaseOrder',
        documentId: 'po-1',
      },
      {
        goodId: 'good-1',
        type: 'RECEIPT',
        quantity: 3,
        createdAt: new Date('2025-01-16'),
        documentType: 'PurchaseOrder',
        documentId: 'po-1',
      },
      {
        goodId: 'good-1',
        type: 'WRITEOFF',
        quantity: -2,
        createdAt: new Date('2025-01-17'),
        documentType: 'WorkOrder',
        documentId: 'wo-1',
      },
    ]);
    const result = await service.byDocument('org-1');
    expect(result.goods[0].documents).toHaveLength(2);
    const poDoc = result.goods[0].documents.find(d => d.documentId === 'po-1');
    expect(poDoc?.movements).toHaveLength(2);
    expect(poDoc?.docLabel).toMatch(/Замовлення/);
    const woDoc = result.goods[0].documents.find(d => d.documentId === 'wo-1');
    expect(woDoc?.docLabel).toMatch(/Наряд/);
  });

  it('застосовує date range до stockMovement.createdAt (не до stockItem)', async () => {
    await service.byDocument('org-1', undefined, undefined, '2025-01-01', '2025-01-31');
    const movementCall = prisma.stockMovement.findMany.mock.calls[0][0];
    expect(movementCall.where.createdAt).toBeDefined();
    expect(movementCall.where.createdAt.gte).toBeInstanceOf(Date);
    expect(movementCall.where.createdAt.lte).toBeInstanceOf(Date);
    // stockItem.findMany має НЕ мати createdAt у where — це звіт по поточному
    // балансу + рухам у вікні, а не лише новостворені stockItems.
    const stockCall = prisma.stockItem.findMany.mock.calls[0][0];
    expect(stockCall.where.createdAt).toBeUndefined();
  });

  it('сортує goods по goodName з українською локаллю', async () => {
    prisma.stockItem.findMany.mockResolvedValueOnce([
      {
        goodId: 'g-z',
        quantity: 1,
        good: { name: 'Ярлик', sku: null, unit: 'шт', brand: null },
        warehouse: { name: 'wh1' },
      },
      {
        goodId: 'g-a',
        quantity: 1,
        good: { name: 'Алмаз', sku: null, unit: 'шт', brand: null },
        warehouse: { name: 'wh1' },
      },
      {
        goodId: 'g-b',
        quantity: 1,
        good: { name: 'Бочка', sku: null, unit: 'шт', brand: null },
        warehouse: { name: 'wh1' },
      },
    ]);
    const result = await service.byDocument('org-1');
    expect(result.goods.map(g => g.goodName)).toEqual(['Алмаз', 'Бочка', 'Ярлик']);
  });

  it('включає good.brand.name у вихід', async () => {
    prisma.stockItem.findMany.mockResolvedValueOnce([
      {
        goodId: 'g-1',
        quantity: 5,
        good: { name: 'Олива', sku: null, unit: 'л', brand: { name: 'Mobil' } },
        warehouse: { name: 'wh1' },
      },
    ]);
    const result = await service.byDocument('org-1');
    expect(result.goods[0].goodBrand).toBe('Mobil');
  });

  it('встановлює goodBrand=null коли brand relation відсутній', async () => {
    prisma.stockItem.findMany.mockResolvedValueOnce([
      {
        goodId: 'g-1',
        quantity: 5,
        good: { name: 'Деталь', sku: null, unit: 'шт', brand: null },
        warehouse: { name: 'wh1' },
      },
    ]);
    const result = await service.byDocument('org-1');
    expect(result.goods[0].goodBrand).toBeNull();
  });
});

describe('InventoryService.byBatch()', () => {
  let service: InventoryService;
  let prisma: {
    stockBatch: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    prisma = { stockBatch: { findMany: vi.fn().mockResolvedValue([]) } };
    const module = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        { provide: BatchService, useValue: { createFromReceipt: vi.fn() } },
        {
          provide: SettingsService,
          useValue: { getOrganisationSettings: vi.fn().mockResolvedValue({ costMethod: 'FIFO' }) },
        },
      ],
    }).compile();
    service = module.get(InventoryService);
  });

  it('повертає `{ batches: [] }` коли немає батчів', async () => {
    const result = await service.byBatch('org-1');
    expect(result).toEqual({ batches: [] });
  });

  it('передає orgId + soft-delete relation-фільтри у where', async () => {
    await service.byBatch('org-1');
    expect(prisma.stockBatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: 'org-1',
          good: { deletedAt: null },
          warehouse: { deletedAt: null },
        }),
      }),
    );
  });

  it('групує батчі по PO number + warehouseId', async () => {
    prisma.stockBatch.findMany.mockResolvedValueOnce([
      {
        id: 'b-1',
        goodId: 'g-1',
        warehouseId: 'wh-1',
        batchNumber: null,
        receivedQty: 10,
        remainingQty: 7,
        costPrice: 100,
        salePrice: 250,
        good: { name: 'Олива', sku: 'OIL-1', brand: { name: 'Mobil' } },
        warehouse: { name: 'Центр' },
        purchaseOrderLine: {
          purchaseOrder: { number: 'PO-001', documentDate: new Date('2025-01-10') },
        },
        consumptions: [],
      },
      {
        id: 'b-2',
        goodId: 'g-2',
        warehouseId: 'wh-1',
        batchNumber: null,
        receivedQty: 5,
        remainingQty: 5,
        costPrice: 200,
        salePrice: 500,
        good: { name: 'Фільтр', sku: 'F-1', brand: null },
        warehouse: { name: 'Центр' },
        purchaseOrderLine: {
          purchaseOrder: { number: 'PO-001', documentDate: new Date('2025-01-10') },
        },
        consumptions: [],
      },
    ]);
    const result = await service.byBatch('org-1');
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0].poNumber).toBe('PO-001');
    expect(result.batches[0].goods).toHaveLength(2);
  });

  it('manual батчі (без purchaseOrderLine) групуються під ключем `manual::warehouseId`', async () => {
    prisma.stockBatch.findMany.mockResolvedValueOnce([
      {
        id: 'b-m',
        goodId: 'g-1',
        warehouseId: 'wh-1',
        batchNumber: 'manual-001',
        receivedQty: 3,
        remainingQty: 3,
        costPrice: 50,
        salePrice: 100,
        good: { name: 'Олива', sku: null, brand: null },
        warehouse: { name: 'Центр' },
        purchaseOrderLine: null,
        consumptions: [],
      },
    ]);
    const result = await service.byBatch('org-1');
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0].poNumber).toBeNull();
    expect(result.batches[0].poDate).toBeNull();
    expect(result.batches[0].batchGroupKey).toBe('manual::wh-1');
  });

  it('конвертує Decimal costPrice/salePrice у number', async () => {
    // Prisma Decimal — об'єкт; service має робити Number(...)
    prisma.stockBatch.findMany.mockResolvedValueOnce([
      {
        id: 'b-1',
        goodId: 'g-1',
        warehouseId: 'wh-1',
        batchNumber: null,
        receivedQty: 10,
        remainingQty: 7,
        costPrice: { toString: () => '123.45' } as unknown as number,
        salePrice: { toString: () => '250.00' } as unknown as number,
        good: { name: 'X', sku: null, brand: null },
        warehouse: { name: 'wh1' },
        purchaseOrderLine: null,
        consumptions: [],
      },
    ]);
    const result = await service.byBatch('org-1');
    expect(typeof result.batches[0].goods[0].costPrice).toBe('number');
    expect(typeof result.batches[0].goods[0].salePrice).toBe('number');
  });

  it('застосовує date range до stockBatch.createdAt', async () => {
    await service.byBatch('org-1', undefined, undefined, '2025-01-01', '2025-01-31');
    const call = prisma.stockBatch.findMany.mock.calls[0][0];
    expect(call.where.createdAt).toBeDefined();
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    expect(call.where.createdAt.lte).toBeInstanceOf(Date);
  });

  it('передає warehouseId/goodId у where коли вказані', async () => {
    await service.byBatch('org-1', 'wh-1', 'good-1');
    const call = prisma.stockBatch.findMany.mock.calls[0][0];
    expect(call.where.warehouseId).toBe('wh-1');
    expect(call.where.goodId).toBe('good-1');
  });
});
