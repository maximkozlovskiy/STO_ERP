/**
 * InventoryService.byBatch()
 *
 * Виділено з `inventory.service.spec.ts` (був 983 рядки, 4 незалежні top-level
 * describe) 2026-10-06. Кейси перенесені ДОСЛІВНО, назви describe не змінені —
 * інакше `fullName` у test-baseline.json розійшовся б.
 */

import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { InventoryService } from './inventory.service';
import { BatchService } from './batch.service';
import { SettingsService } from '../settings/settings.service';
import { PrismaService } from '../../prisma/prisma.service';

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
