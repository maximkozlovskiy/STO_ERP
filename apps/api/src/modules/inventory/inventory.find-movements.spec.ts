/**
 * InventoryService.findMovements() — журнал рухів
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

describe('InventoryService.findMovements() — журнал рухів (пагінація + фільтри)', () => {
  let service: InventoryService;
  let prisma: {
    stockMovement: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  };

  const mkModule = async () => {
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
    return module.get(InventoryService) as InventoryService;
  };

  beforeEach(async () => {
    prisma = {
      stockMovement: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    service = await mkModule();
  });

  it('порожньо → { items: [], total: 0, page: 1, limit: 50 }', async () => {
    const r = await service.findMovements('org-1', { limit: 50 });
    expect(r).toEqual({ items: [], total: 0, page: 1, limit: 50 });
  });

  it('tenant + soft-delete + orderBy desc + пагінація у findMany/count', async () => {
    prisma.stockMovement.count.mockResolvedValue(120);
    await service.findMovements('org-1', { page: 2, limit: 50 });
    const findArg = prisma.stockMovement.findMany.mock.calls[0][0];
    expect(findArg.where).toMatchObject({
      orgId: 'org-1',
      good: { deletedAt: null },
      warehouse: { deletedAt: null },
    });
    expect(findArg.orderBy).toEqual({ createdAt: 'desc' });
    expect(findArg.skip).toBe(50); // (page2-1)*50
    expect(findArg.take).toBe(50);
    // count теж scoped orgId (той самий where).
    expect(prisma.stockMovement.count.mock.calls[0][0].where).toMatchObject({ orgId: 'org-1' });
  });

  it('фільтри goodId/warehouseId/type/from-to потрапляють у where', async () => {
    await service.findMovements('org-1', {
      goodId: 'g1',
      warehouseId: 'w1',
      type: 'WRITEOFF' as never,
      from: '2026-09-01',
      to: '2026-09-30',
    });
    const where = prisma.stockMovement.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ goodId: 'g1', warehouseId: 'w1', type: 'WRITEOFF' });
    expect(where.createdAt).toBeDefined(); // normalizeDates застосовано
  });

  it('limit капується (MAX 200) — DoS guard', async () => {
    await service.findMovements('org-1', { limit: 999999 });
    expect(prisma.stockMovement.findMany.mock.calls[0][0].take).toBe(200);
  });

  it('мапить рядок у DTO (goodName/warehouseName/price Number|null)', async () => {
    prisma.stockMovement.findMany.mockResolvedValue([
      {
        id: 'm1',
        type: 'RECEIPT',
        quantity: 5,
        price: { toString: () => '12.50' }, // Prisma.Decimal-подібне
        goodId: 'g1',
        warehouseId: 'w1',
        documentType: 'PurchaseOrder',
        documentId: 'po1',
        notes: null,
        createdAt: new Date('2026-09-10T00:00:00Z'),
        good: { name: 'Олива', sku: 'OIL-1' },
        warehouse: { name: 'Головний' },
      },
    ]);
    prisma.stockMovement.count.mockResolvedValue(1);
    const r = await service.findMovements('org-1', {});
    expect(r.items[0]).toMatchObject({
      id: 'm1',
      type: 'RECEIPT',
      quantity: 5,
      price: 12.5,
      goodName: 'Олива',
      goodSku: 'OIL-1',
      warehouseName: 'Головний',
      documentType: 'PurchaseOrder',
    });
  });
});
