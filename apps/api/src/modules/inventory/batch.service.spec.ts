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
    };
    batchConsumption: { create: ReturnType<typeof vi.fn> };
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
      },
      batchConsumption: { create: vi.fn().mockResolvedValue({}) },
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
      expect(result).toEqual([{ batchId: '', quantity: 5, costPrice: 150 }]);
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

    it('інкрементує remainingQty і робить isActive=true', async () => {
      prisma.stockBatch.findFirst.mockResolvedValue({ id: 'b1', goodId: 'g1' });
      await service.returnToBatch('org', 'b1', 5, 'WO', 'wo1');
      expect(prisma.stockBatch.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { remainingQty: { increment: 5 }, isActive: true },
      });
      expect(prisma.batchConsumption.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ quantity: 5, batchId: 'b1' }),
      });
    });
  });
});
