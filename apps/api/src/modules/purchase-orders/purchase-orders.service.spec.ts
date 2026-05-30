import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PricingService } from '../inventory/pricing.service';

// Bug #187: regression-захист для applyPricing
describe('PurchaseOrdersService.applyPricing', () => {
  let service: PurchaseOrdersService;
  let prisma: {
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn> };
    good: { updateMany: ReturnType<typeof vi.fn> };
    priceHistory: { create: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let pricingService: { calculateSalePrice: ReturnType<typeof vi.fn> };

  const ORG = 'org-1';
  const PO_ID = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    prisma = {
      purchaseOrder: { findFirst: vi.fn() },
      good: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      priceHistory: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
    };
    pricingService = { calculateSalePrice: vi.fn() };

    const module = await Test.createTestingModule({
      providers: [
        PurchaseOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: {} },
        { provide: SettlementsService, useValue: {} },
        { provide: DocumentNumberService, useValue: {} },
        { provide: PricingService, useValue: pricingService },
      ],
    }).compile();
    service = module.get(PurchaseOrdersService);
  });

  it('кидає NotFoundException коли PO не знайдено', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(null);
    await expect(service.applyPricing(ORG, PO_ID))
      .rejects.toThrow(NotFoundException);
    expect(prisma.good.updateMany).not.toHaveBeenCalled();
    expect(prisma.priceHistory.create).not.toHaveBeenCalled();
  });

  it('PO без lines → { updated: 0, details: [] } без жодного writeу', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID, orgId: ORG, number: 'PO-001', lines: [],
    });
    const result = await service.applyPricing(ORG, PO_ID);
    expect(result).toEqual({ updated: 0, details: [] });
    expect(pricingService.calculateSalePrice).not.toHaveBeenCalled();
    expect(prisma.good.updateMany).not.toHaveBeenCalled();
    expect(prisma.priceHistory.create).not.toHaveBeenCalled();
  });

  it('ціна не змінилась (різниця < 0.001) → skip: не пише ні good.updateMany ні priceHistory', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID, orgId: ORG, number: 'PO-002',
      lines: [
        {
          goodId: 'good-1', price: 100,
          good: { name: 'Filter', salePrice: 130, category: null, goodType: 'SPARE_PART', brandId: null },
        },
      ],
    });
    // pricingService повертає те саме значення (130) → різниця = 0
    pricingService.calculateSalePrice.mockResolvedValueOnce(130);

    const result = await service.applyPricing(ORG, PO_ID);

    expect(result.updated).toBe(0);
    expect(result.details).toHaveLength(0);
    expect(prisma.good.updateMany).not.toHaveBeenCalled();
    expect(prisma.priceHistory.create).not.toHaveBeenCalled();
  });

  it('ціна змінилась → виклик $transaction([good.updateMany, priceHistory.create])', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID, orgId: ORG, number: 'PO-003',
      lines: [
        {
          goodId: 'good-2', price: 100,
          good: { name: 'Brake pad', salePrice: 130, category: 'BRAKES', goodType: 'SPARE_PART', brandId: 'brand-1' },
        },
      ],
    });
    pricingService.calculateSalePrice.mockResolvedValueOnce(150);

    const result = await service.applyPricing(ORG, PO_ID);

    expect(result.updated).toBe(1);
    expect(result.details).toEqual([{
      goodId: 'good-2',
      goodName: 'Brake pad',
      costPrice: 100,
      oldSalePrice: 130,
      newSalePrice: 150,
    }]);
    // Bug #191: updateMany з orgId — defense-in-depth
    expect(prisma.good.updateMany).toHaveBeenCalledWith({
      where: { id: 'good-2', orgId: ORG, deletedAt: null },
      data: { salePrice: 150 },
    });
    expect(prisma.priceHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: ORG,
        goodId: 'good-2',
        oldPrice: 130,
        newPrice: 150,
        costPrice: 100,
        reason: expect.stringContaining('PO-003'),
      }),
    });
  });

  it('mixed lines (одна змінилась, інша ні) → updated=1, тільки один write', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID, orgId: ORG, number: 'PO-004',
      lines: [
        {
          goodId: 'g-a', price: 100,
          good: { name: 'A', salePrice: 150, category: null, goodType: null, brandId: null },
        },
        {
          goodId: 'g-b', price: 50,
          good: { name: 'B', salePrice: 70, category: null, goodType: null, brandId: null },
        },
      ],
    });
    pricingService.calculateSalePrice
      .mockResolvedValueOnce(150) // no change for A
      .mockResolvedValueOnce(80); // change for B

    const result = await service.applyPricing(ORG, PO_ID);
    expect(result.updated).toBe(1);
    expect(result.details).toEqual([{
      goodId: 'g-b', goodName: 'B', costPrice: 50, oldSalePrice: 70, newSalePrice: 80,
    }]);
    expect(prisma.good.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.good.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'g-b' }) }),
    );
  });

  it('пропускає line.good=null (soft-deleted Good) без TypeError', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID, orgId: ORG, number: 'PO-005',
      lines: [
        { goodId: 'orphan', price: 100, good: null },
      ],
    });
    const result = await service.applyPricing(ORG, PO_ID);
    expect(result.updated).toBe(0);
    expect(pricingService.calculateSalePrice).not.toHaveBeenCalled();
    expect(prisma.good.updateMany).not.toHaveBeenCalled();
  });
});
