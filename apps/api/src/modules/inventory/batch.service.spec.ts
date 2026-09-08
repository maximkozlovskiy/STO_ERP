import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { BatchService } from './batch.service';
import { PricingService } from './pricing.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('BatchService', () => {
  let service: BatchService;
  let prisma: {
    good: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    stockBatch: {
      create: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    batchConsumption: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
    };
    priceHistory: { create: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  let pricing: {
    calculateSalePrice: ReturnType<typeof vi.fn>;
    getActiveRulesForOrg: ReturnType<typeof vi.fn>;
    computePriceFromRules: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    prisma = {
      good: { findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}) },
      stockBatch: {
        create: vi.fn().mockResolvedValue({ id: 'b1' }),
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        // Bug #613 — conditional decrement через updateMany з `remainingQty: { gte: take }`.
        // За успішного мока — count=1 (декремент застосувався); тести можуть
        // mockResolvedValueOnce({ count: 0 }) для race-scenario.
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      batchConsumption: {
        create: vi.fn().mockResolvedValue({}),
        findFirst: vi.fn().mockResolvedValue(null), // за замовч. немає наявного повернення
      },
      priceHistory: { create: vi.fn().mockResolvedValue({}) },
      // Bug #20: consumeBatch/returnToBatch обертає в $transaction коли tx не передано.
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (typeof arg === 'function') {
          return (arg as (tx: typeof prisma) => Promise<unknown>)(prisma);
        }
        return Promise.all(arg as Promise<unknown>[]);
      }),
      // sto-optimize: getAvgCost використовує $queryRaw для weighted SUM (1 RTT
      // замість findMany 500 + JS reduce ×2). Тагований template literal приймає
      // strings array + N values — повертаємо те що тест передав через mockResolvedValueOnce.
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    // Refactor (cycle 3): createFromReceipt тепер паралельно тягне good + active rules
    // і використовує sync `computePriceFromRules` замість async `calculateSalePrice`.
    pricing = {
      calculateSalePrice: vi.fn().mockResolvedValue(150),
      getActiveRulesForOrg: vi.fn().mockResolvedValue([]),
      computePriceFromRules: vi.fn().mockReturnValue(150),
    };

    const module = await Test.createTestingModule({
      providers: [
        BatchService,
        { provide: PrismaService, useValue: prisma },
        { provide: PricingService, useValue: pricing },
      ],
    }).compile();
    service = module.get(BatchService);
  });

  describe('createFromReceipt', () => {
    it('кидає якщо good не знайдено', async () => {
      prisma.good.findFirst.mockResolvedValue(null);
      await expect(
        service.createFromReceipt('org', {
          goodId: 'g1',
          warehouseId: 'wh1',
          stockMovementId: 'm1',
          receivedQty: 10,
          costPrice: 100,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('створює партію і логує PriceHistory якщо ціна змінилась', async () => {
      prisma.good.findFirst.mockResolvedValue({
        id: 'g1',
        category: 'X',
        goodType: 'SPARE_PART',
        salePrice: 100,
      });
      pricing.computePriceFromRules.mockReturnValue(150);
      await service.createFromReceipt('org', {
        goodId: 'g1',
        warehouseId: 'wh1',
        stockMovementId: 'm1',
        receivedQty: 10,
        costPrice: 100,
      });
      expect(prisma.stockBatch.create).toHaveBeenCalled();
      expect(prisma.good.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { salePrice: 150 } }),
      );
      expect(prisma.priceHistory.create).toHaveBeenCalled();
    });

    it('НЕ логує PriceHistory якщо ціна не змінилась', async () => {
      prisma.good.findFirst.mockResolvedValue({
        id: 'g1',
        category: null,
        goodType: null,
        salePrice: 150,
      });
      pricing.computePriceFromRules.mockReturnValue(150);
      await service.createFromReceipt('org', {
        goodId: 'g1',
        warehouseId: 'wh1',
        stockMovementId: 'm1',
        receivedQty: 10,
        costPrice: 100,
      });
      expect(prisma.priceHistory.create).not.toHaveBeenCalled();
      expect(prisma.good.update).not.toHaveBeenCalled();
    });

    it('Bug #14: безкоштовний прийом (costPrice=0) НЕ змінює Good.salePrice', async () => {
      prisma.good.findFirst.mockResolvedValue({
        id: 'g1',
        category: null,
        goodType: null,
        salePrice: 250,
      });
      pricing.computePriceFromRules.mockReturnValue(0); // pricing service may return 0 from 0 cost
      await service.createFromReceipt('org', {
        goodId: 'g1',
        warehouseId: 'wh1',
        stockMovementId: 'm1',
        receivedQty: 5,
        costPrice: 0,
      });
      // НЕ перезаписувати ціну продажу
      expect(prisma.good.update).not.toHaveBeenCalled();
      expect(prisma.priceHistory.create).not.toHaveBeenCalled();
      // Партія створена з salePrice = поточна ціна товару (250), не 0
      expect(prisma.stockBatch.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ costPrice: 0, salePrice: 250 }),
        }),
      );
    });
  });

  describe('consumeBatch', () => {
    it('AVG_COST повертає середню вартість', async () => {
      // sto-optimize: AVG_COST шлях кличе getAvgCost → $queryRaw weighted SUM.
      // SUM(qty*cost) = 5*100 + 5*200 = 1500; SUM(qty) = 10; 1500/10 = 150.
      prisma.$queryRaw.mockResolvedValueOnce([{ total_cost: 1500, total_qty: 10 }]);
      const result = await service.consumeBatch(
        'org',
        'g1',
        'wh1',
        5,
        'WO',
        'wo1',
        undefined,
        'AVG_COST',
      );
      // AVG_COST — агрегат, batchId=null (не одна фізична партія; лягає у nullable uuid).
      expect(result).toEqual([{ batchId: null, quantity: 5, costPrice: 150 }]);
    });

    it('FIFO: списує з найстарішої партії', async () => {
      prisma.stockBatch.findMany.mockResolvedValue([
        { id: 'old', remainingQty: 5, costPrice: 100 },
        { id: 'new', remainingQty: 10, costPrice: 200 },
      ]);
      const result = await service.consumeBatch(
        'org',
        'g1',
        'wh1',
        8,
        'WO',
        'wo1',
        undefined,
        'FIFO',
      );
      expect(result).toEqual([
        { batchId: 'old', quantity: 5, costPrice: 100 },
        { batchId: 'new', quantity: 3, costPrice: 200 },
      ]);
    });

    it('кидає якщо партій недостатньо', async () => {
      prisma.stockBatch.findMany.mockResolvedValue([{ id: 'b1', remainingQty: 3, costPrice: 100 }]);
      await expect(
        service.consumeBatch('org', 'g1', 'wh1', 10, 'WO', 'wo1', undefined, 'FIFO'),
      ).rejects.toThrow(BadRequestException);
    });

    // Bug #623 (d74b7b3d, audit 2026-09-04): exhaustion-check `remaining > QTY_EPSILON`
    // (не `remaining > 0`). Дробові одиниці (літри/кг) через IEEE-754 лишають float-дрейф:
    // 0.3 − 0.1 − 0.1 − 0.1 ≈ −2.7e-17 → з порогом 0 законне ПОВНЕ списання кидало б хибне
    // «Недостатньо партій: бракує 2.7e-17 одиниць». d74b7b3d виправив, але без regression-test.
    it('Bug #623: дробове повне списання (3×0.1 для qty=0.3) НЕ кидає (float-дрейф ≤ epsilon)', async () => {
      prisma.stockBatch.findMany.mockResolvedValue([
        { id: 'p1', remainingQty: 0.1, costPrice: 50 },
        { id: 'p2', remainingQty: 0.1, costPrice: 50 },
        { id: 'p3', remainingQty: 0.1, costPrice: 50 },
      ]);
      const result = await service.consumeBatch(
        'org',
        'g1',
        'wh1',
        0.3,
        'WO',
        'wo1',
        undefined,
        'FIFO',
      );
      const consumed = result.reduce((s, r) => s + r.quantity, 0);
      expect(consumed).toBeCloseTo(0.3, 9);
    });

    it('Bug #623: реальна дробова нестача (qty=0.5, доступно 0.3) → все ще кидає', async () => {
      prisma.stockBatch.findMany.mockResolvedValue([
        { id: 'p1', remainingQty: 0.1, costPrice: 50 },
        { id: 'p2', remainingQty: 0.1, costPrice: 50 },
        { id: 'p3', remainingQty: 0.1, costPrice: 50 },
      ]);
      await expect(
        service.consumeBatch('org', 'g1', 'wh1', 0.5, 'WO', 'wo1', undefined, 'FIFO'),
      ).rejects.toThrow(BadRequestException);
    });

    it('записує BatchConsumption з негативним quantity', async () => {
      prisma.stockBatch.findMany.mockResolvedValue([
        { id: 'b1', remainingQty: 10, costPrice: 100 },
      ]);
      await service.consumeBatch('org', 'g1', 'wh1', 4, 'WO', 'wo1', 'line1', 'FIFO');
      expect(prisma.batchConsumption.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ quantity: -4, documentLineId: 'line1' }),
      });
    });

    // Bug #609: regression-guard для orderBy різних costMethod. Refactor який
    // випадково поміняє asc↔desc для LIFO/FEFO пройде CI зеленим без цих тестів
    // (verified live: LIFO бере найновішу партію @120, FEFO fallback на createdAt asc).
    it('LIFO: використовує orderBy createdAt desc (найновіша перша)', async () => {
      prisma.stockBatch.findMany.mockResolvedValue([
        { id: 'newer', remainingQty: 5, costPrice: 200 },
        { id: 'older', remainingQty: 10, costPrice: 100 },
      ]);
      await service.consumeBatch('org', 'g1', 'wh1', 3, 'WO', 'wo1', undefined, 'LIFO');
      expect(prisma.stockBatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ createdAt: 'desc' }] }),
      );
    });

    it('FEFO: orderBy expiryDate asc nulls last, then createdAt asc', async () => {
      prisma.stockBatch.findMany.mockResolvedValue([
        { id: 'exp-soon', remainingQty: 5, costPrice: 100 },
      ]);
      await service.consumeBatch('org', 'g1', 'wh1', 3, 'WO', 'wo1', undefined, 'FEFO');
      expect(prisma.stockBatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        }),
      );
    });

    it('FIFO: orderBy createdAt asc (найстаріша перша)', async () => {
      prisma.stockBatch.findMany.mockResolvedValue([
        { id: 'old', remainingQty: 5, costPrice: 100 },
      ]);
      await service.consumeBatch('org', 'g1', 'wh1', 3, 'WO', 'wo1', undefined, 'FIFO');
      expect(prisma.stockBatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ createdAt: 'asc' }] }),
      );
    });

    // Bug #613 — conditional decrement через updateMany з `remainingQty: { gte: take }`
    // захищає від concurrent consume race window: два одночасних WRITEOFF одного
    // goodId+warehouseId читають ту саму findMany snapshot → без gte-фільтра другий
    // декремент дав би від'ємний remainingQty. updateMany з count=0 = race lost → throw.
    it('Bug #613: використовує updateMany з фільтром remainingQty: { gte: take } (не update)', async () => {
      prisma.stockBatch.findMany.mockResolvedValue([
        { id: 'b1', remainingQty: 10, costPrice: 100 },
      ]);
      await service.consumeBatch('org', 'g1', 'wh1', 4, 'WO', 'wo1', undefined, 'FIFO');
      expect(prisma.stockBatch.updateMany).toHaveBeenCalledWith({
        // orgId — defense-in-depth tenant guard (CLAUDE.md #6).
        where: { id: 'b1', orgId: 'org', remainingQty: { gte: 4 } },
        data: expect.objectContaining({ remainingQty: { decrement: 4 } }),
      });
      // Плюс: старий update — НЕ викликаний у consume-path (тільки createFromReceipt / returnToBatch)
      expect(prisma.stockBatch.update).not.toHaveBeenCalled();
    });

    it('Bug #613: race lost (updateMany.count=0) → BadRequestException + $tx rollback', async () => {
      prisma.stockBatch.findMany.mockResolvedValue([
        { id: 'b1', remainingQty: 10, costPrice: 100 },
      ]);
      // Симулюємо race: інший tx декрементив партію між findMany і updateMany → count=0.
      prisma.stockBatch.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(
        service.consumeBatch('org', 'g1', 'wh1', 4, 'WO', 'wo1', undefined, 'FIFO'),
      ).rejects.toThrow(/Партію змінено іншою транзакцією|повторіть операцію/i);
    });
  });

  describe('getAvgCost', () => {
    it('повертає 0 коли немає партій', async () => {
      // sto-optimize: Postgres weighted SUM повертає рядок з нулями коли recent CTE порожній.
      prisma.$queryRaw.mockResolvedValueOnce([{ total_cost: 0, total_qty: 0 }]);
      const cost = await service.getAvgCost('org', 'g1', 'wh1');
      expect(cost).toBe(0);
    });

    it('зважена середня по remainingQty', async () => {
      // Postgres рахує: SUM(qty*cost)=2*100+8*200=1800, SUM(qty)=10; service ділить на 10 → 180.
      prisma.$queryRaw.mockResolvedValueOnce([{ total_cost: 1800, total_qty: 10 }]);
      const cost = await service.getAvgCost('org', 'g1', 'wh1');
      expect(cost).toBe(180);
    });
  });

  describe('returnToBatch', () => {
    it('кидає якщо партію не знайдено', async () => {
      prisma.stockBatch.findFirst.mockResolvedValue(null);
      await expect(service.returnToBatch('org', 'missing', 5, 'WO', 'wo1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('інкрементує remainingQty (CAS з верхнім cap) + isActive=true + batchConsumption', async () => {
      prisma.stockBatch.findFirst.mockResolvedValue({ id: 'b1', goodId: 'g1', receivedQty: 10 });
      prisma.stockBatch.updateMany.mockResolvedValueOnce({ count: 1 });
      await service.returnToBatch('org', 'b1', 5, 'WO', 'wo1');
      // CAS: remainingQty <= receivedQty - qty (10-5=5), orgId у where, increment.
      expect(prisma.stockBatch.updateMany).toHaveBeenCalledWith({
        where: { id: 'b1', orgId: 'org', remainingQty: { lte: 5 } },
        data: { remainingQty: { increment: 5 }, isActive: true },
      });
      expect(prisma.batchConsumption.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ quantity: 5, batchId: 'b1' }),
      });
    });

    it('cap: повернення перевищує залишок місткості (updateMany.count=0) → BadRequest + rollback', async () => {
      prisma.stockBatch.findFirst.mockResolvedValue({ id: 'b1', goodId: 'g1', receivedQty: 10 });
      // remainingQty=8, повертаємо 5 → 8 > 10-5=5 → CAS не матчить → count=0.
      prisma.stockBatch.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.returnToBatch('org', 'b1', 5, 'WO', 'wo1')).rejects.toThrow(
        /перевищує отриману/i,
      );
    });

    it('ідемпотентність: наявне повернення на той самий документ → skip (без подвоєння)', async () => {
      prisma.stockBatch.findFirst.mockResolvedValue({ id: 'b1', goodId: 'g1', receivedQty: 10 });
      prisma.batchConsumption.findFirst.mockResolvedValueOnce({ id: 'existing' });
      await service.returnToBatch('org', 'b1', 5, 'WO', 'wo1');
      expect(prisma.stockBatch.updateMany).not.toHaveBeenCalled();
      expect(prisma.batchConsumption.create).not.toHaveBeenCalled();
    });
  });
});
