/**
 * SupplierReturnsService — пов'язані документи (Phase D3)
 *
 * Виділено з `supplier-returns.service.spec.ts` (був 913 рядків, 5 незалежних
 * top-level describe) 2026-10-05. Кейси перенесені ДОСЛІВНО, назви describe не
 * змінені — інакше `fullName` у test-baseline.json розійшовся б.
 */

import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SupplierReturnsService } from './supplier-returns.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DocumentNumberService } from '../document-number/document-number.service';

describe('SupplierReturnsService — linked documents (Phase D3)', () => {
  let service: SupplierReturnsService;
  let prisma: {
    supplierReturn: { findFirst: any; findMany: any };
    purchaseOrder: { findFirst: any; findMany: any };
    counterparty: { findFirst: any; findMany: any };
    warehouse: { findFirst: any; findMany: any };
  };

  const ORG = 'org-1';
  const SR_ID = '11111111-1111-4111-8111-111111111111';
  const PO_ID = '22222222-2222-4222-8222-222222222222';
  const SUPPLIER_ID_LOCAL = '33333333-3333-4333-8333-333333333333';
  const WAREHOUSE_ID_LOCAL = '44444444-4444-4444-8444-444444444444';

  beforeEach(async () => {
    prisma = {
      supplierReturn: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      purchaseOrder: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      counterparty: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      warehouse: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    };
    const module = await Test.createTestingModule({
      providers: [
        SupplierReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: {} },
        { provide: SettlementsService, useValue: {} },
        { provide: DocumentNumberService, useValue: { next: vi.fn() } },
      ],
    }).compile();
    service = module.get(SupplierReturnsService);
  });

  it('getLinkedDocuments: неіснуюче/чуже повернення → порожні секції (без throw)', async () => {
    prisma.supplierReturn.findFirst.mockResolvedValueOnce(null);
    const res = await service.getLinkedDocuments(ORG, 'other-org-sr');
    expect(res).toEqual({ purchaseOrder: [], counterparty: [], warehouse: [] });
    expect(prisma.counterparty.findFirst).not.toHaveBeenCalled();
    expect(prisma.warehouse.findFirst).not.toHaveBeenCalled();
  });

  it('getLinkedDocuments: без purchaseOrderId → purchaseOrder=[]; counterparty+warehouse завжди присутні', async () => {
    prisma.supplierReturn.findFirst.mockResolvedValueOnce({
      purchaseOrderId: null,
      supplierId: SUPPLIER_ID_LOCAL,
      warehouseId: WAREHOUSE_ID_LOCAL,
    });
    prisma.counterparty.findFirst.mockResolvedValueOnce({
      id: SUPPLIER_ID_LOCAL,
      firstName: null,
      lastName: null,
      companyName: 'ТОВ Постачальник',
      phone: '+380501234567',
    });
    prisma.warehouse.findFirst.mockResolvedValueOnce({ id: WAREHOUSE_ID_LOCAL, name: 'Склад' });

    const res = await service.getLinkedDocuments(ORG, SR_ID);
    expect(res.purchaseOrder).toEqual([]);
    expect(prisma.purchaseOrder.findFirst).not.toHaveBeenCalled();
    expect(res.counterparty).toEqual([
      {
        id: SUPPLIER_ID_LOCAL,
        firstName: null,
        lastName: null,
        companyName: 'ТОВ Постачальник',
        phone: '+380501234567',
      },
    ]);
    expect(res.warehouse).toEqual([{ id: WAREHOUSE_ID_LOCAL, name: 'Склад' }]);
  });

  it('getLinkedDocuments: з purchaseOrderId → orgId+deletedAt:null; Decimal→Number', async () => {
    prisma.supplierReturn.findFirst.mockResolvedValueOnce({
      purchaseOrderId: PO_ID,
      supplierId: SUPPLIER_ID_LOCAL,
      warehouseId: WAREHOUSE_ID_LOCAL,
    });
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      number: 'PO-1',
      status: 'RECEIVED',
      totalAmount: { toString: () => '300' } as unknown as number,
    });
    prisma.counterparty.findFirst.mockResolvedValueOnce(null);
    prisma.warehouse.findFirst.mockResolvedValueOnce(null);

    const res = await service.getLinkedDocuments(ORG, SR_ID);
    expect(prisma.purchaseOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: PO_ID, orgId: ORG, deletedAt: null }),
      }),
    );
    expect(res.purchaseOrder[0].totalAmount).toBe(300); // Number, не Decimal/об'єкт
  });

  it('getLinkedCounts: zero-init для КОЖНОГО id + порожній вхід → {}', async () => {
    expect(await service.getLinkedCounts(ORG, [])).toEqual({});
    const res = await service.getLinkedCounts(ORG, [SR_ID, 'sr-2']);
    expect(res[SR_ID]).toEqual({ purchaseOrder: 0, counterparty: 0, warehouse: 0 });
    expect(res['sr-2']).toBeDefined();
  });

  it('getLinkedCounts: purchaseOrder=1 коли purchaseOrderId задано; counterparty/warehouse=1 коли живі (count == detail)', async () => {
    prisma.supplierReturn.findMany.mockResolvedValueOnce([
      {
        id: SR_ID,
        purchaseOrderId: PO_ID,
        supplierId: SUPPLIER_ID_LOCAL,
        warehouseId: WAREHOUSE_ID_LOCAL,
      },
    ]);
    // Bug #A/#641 liveness: PO + постачальник + склад живі → count == detail.
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([{ id: PO_ID }]);
    prisma.counterparty.findMany.mockResolvedValueOnce([{ id: SUPPLIER_ID_LOCAL }]);
    prisma.warehouse.findMany.mockResolvedValueOnce([{ id: WAREHOUSE_ID_LOCAL }]);
    const res = await service.getLinkedCounts(ORG, [SR_ID]);
    expect(res[SR_ID]).toEqual({ purchaseOrder: 1, counterparty: 1, warehouse: 1 });
    expect(prisma.supplierReturn.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orgId: ORG, deletedAt: null }),
      }),
    );
  });

  it('getLinkedCounts: soft-deleted PO/постачальник/склад → count=0 (count == detail, Bug #A/#641)', async () => {
    prisma.supplierReturn.findMany.mockResolvedValueOnce([
      {
        id: SR_ID,
        purchaseOrderId: PO_ID,
        supplierId: SUPPLIER_ID_LOCAL,
        warehouseId: WAREHOUSE_ID_LOCAL,
      },
    ]);
    // Нічого не живе (усі soft-deleted) → усі count=0.
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([]);
    prisma.counterparty.findMany.mockResolvedValueOnce([]);
    prisma.warehouse.findMany.mockResolvedValueOnce([]);
    const res = await service.getLinkedCounts(ORG, [SR_ID]);
    expect(res[SR_ID]).toEqual({ purchaseOrder: 0, counterparty: 0, warehouse: 0 });
  });
});

/**
 * Phase D2 — опціональний PO-джерело у create(). Персистенція + FK-guard.
 */
