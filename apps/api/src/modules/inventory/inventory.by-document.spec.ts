/**
 * InventoryService.byDocument()
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
