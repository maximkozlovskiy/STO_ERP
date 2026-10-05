/**
 * StockDocumentsService — linked documents (Phase D3)
 *
 * Виділено з `stock-documents.service.spec.ts` (був 1040 рядків, 4 незалежні
 * top-level describe) 2026-10-05. Кейси перенесені ДОСЛІВНО, назви describe
 * не змінені — інакше `fullName` у test-baseline.json розійшовся б.
 */

import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { StockDocumentsService } from './stock-documents.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { DocumentNumberService } from '../document-number/document-number.service';

describe('StockDocumentsService — linked documents (Phase D3)', () => {
  let service: StockDocumentsService;
  let prisma: {
    stockDocument: { findFirst: any; findMany: any };
    purchaseOrder: { findFirst: any; findMany: any };
    warehouse: { findFirst: any; findMany: any };
  };

  const ORG = 'org-1';
  const DOC_ID = '11111111-1111-4111-8111-111111111111';
  const PO_ID = '22222222-2222-4222-8222-222222222222';
  const WAREHOUSE_ID = '33333333-3333-4333-8333-333333333333';
  const TARGET_WAREHOUSE_ID = '44444444-4444-4444-8444-444444444444';

  beforeEach(async () => {
    prisma = {
      stockDocument: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      purchaseOrder: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      warehouse: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    };
    const module = await Test.createTestingModule({
      providers: [
        StockDocumentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: {} },
        { provide: DocumentNumberService, useValue: { next: vi.fn() } },
      ],
    }).compile();
    service = module.get(StockDocumentsService);
  });

  it('getLinkedDocuments: неіснуючий/чужий документ → порожні секції (без throw)', async () => {
    prisma.stockDocument.findFirst.mockResolvedValueOnce(null);
    const res = await service.getLinkedDocuments(ORG, 'other-org-doc');
    expect(res).toEqual({ purchaseOrder: [], warehouses: [] });
    expect(prisma.purchaseOrder.findFirst).not.toHaveBeenCalled();
    expect(prisma.warehouse.findFirst).not.toHaveBeenCalled();
  });

  it('getLinkedDocuments: без purchaseOrderId і targetWarehouseId → лише джерело-склад', async () => {
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      purchaseOrderId: null,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: null,
    });
    prisma.warehouse.findFirst.mockResolvedValueOnce({ id: WAREHOUSE_ID, name: 'Головний склад' });
    const res = await service.getLinkedDocuments(ORG, DOC_ID);
    expect(res.purchaseOrder).toEqual([]);
    expect(res.warehouses).toEqual([{ id: WAREHOUSE_ID, name: 'Головний склад' }]);
    expect(prisma.purchaseOrder.findFirst).not.toHaveBeenCalled();
  });

  it('getLinkedDocuments: TRANSFER з targetWarehouseId → 2 склади; orgId+deletedAt:null; Decimal→Number', async () => {
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      purchaseOrderId: PO_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: TARGET_WAREHOUSE_ID,
    });
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      number: 'PO-1',
      status: 'ORDERED',
      totalAmount: { toString: () => '500' } as unknown as number,
    });
    prisma.warehouse.findFirst
      .mockResolvedValueOnce({ id: WAREHOUSE_ID, name: 'Джерело' })
      .mockResolvedValueOnce({ id: TARGET_WAREHOUSE_ID, name: 'Призначення' });

    const res = await service.getLinkedDocuments(ORG, DOC_ID);

    expect(prisma.purchaseOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: PO_ID, orgId: ORG, deletedAt: null }),
      }),
    );
    expect(res.purchaseOrder[0].totalAmount).toBe(500); // Number, не Decimal/об'єкт
    expect(res.warehouses).toEqual([
      { id: WAREHOUSE_ID, name: 'Джерело' },
      { id: TARGET_WAREHOUSE_ID, name: 'Призначення' },
    ]);
  });

  it('getLinkedCounts: zero-init для КОЖНОГО id + порожній вхід → {}', async () => {
    expect(await service.getLinkedCounts(ORG, [])).toEqual({});
    const res = await service.getLinkedCounts(ORG, [DOC_ID, 'doc-2']);
    expect(res[DOC_ID]).toEqual({ purchaseOrder: 0, warehouses: 0 });
    expect(res['doc-2']).toBeDefined();
  });

  it('getLinkedCounts: purchaseOrder=1 коли purchaseOrderId задано; warehouses=2 для TRANSFER (count == detail)', async () => {
    prisma.stockDocument.findMany.mockResolvedValueOnce([
      {
        id: DOC_ID,
        purchaseOrderId: PO_ID,
        warehouseId: WAREHOUSE_ID,
        targetWarehouseId: TARGET_WAREHOUSE_ID,
      },
    ]);
    // Bug #A/#641 liveness: PO + обидва склади живі → count == detail.
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([{ id: PO_ID }]);
    prisma.warehouse.findMany.mockResolvedValueOnce([
      { id: WAREHOUSE_ID },
      { id: TARGET_WAREHOUSE_ID },
    ]);
    const res = await service.getLinkedCounts(ORG, [DOC_ID]);
    expect(res[DOC_ID]).toEqual({ purchaseOrder: 1, warehouses: 2 });
    expect(prisma.stockDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orgId: ORG, deletedAt: null }),
      }),
    );
  });

  it('getLinkedCounts: soft-deleted PO/склад → count=0 (count == detail, Bug #A/#641)', async () => {
    prisma.stockDocument.findMany.mockResolvedValueOnce([
      {
        id: DOC_ID,
        purchaseOrderId: PO_ID,
        warehouseId: WAREHOUSE_ID,
        targetWarehouseId: TARGET_WAREHOUSE_ID,
      },
    ]);
    // PO і target-склад soft-deleted (не повертаються liveness-запитом); живий лише джерело.
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([]);
    prisma.warehouse.findMany.mockResolvedValueOnce([{ id: WAREHOUSE_ID }]);
    const res = await service.getLinkedCounts(ORG, [DOC_ID]);
    expect(res[DOC_ID]).toEqual({ purchaseOrder: 0, warehouses: 1 });
  });

  // Item 1 (sto-tester Phase D): не-TRANSFER документ → warehouses count == 1 (лише джерело),
  // count == detail. getLinkedDocuments для того самого doc теж дає 1 склад (перевірено
  // окремим detail-тестом вище). Дискримінатор проти регресії, де targetWarehouseId=null
  // помилково рахувався б як 0 або джерело не рахувалось би.
  it('getLinkedCounts: не-TRANSFER (targetWarehouseId=null) → warehouses=1 (лише живе джерело)', async () => {
    prisma.stockDocument.findMany.mockResolvedValueOnce([
      { id: DOC_ID, purchaseOrderId: null, warehouseId: WAREHOUSE_ID, targetWarehouseId: null },
    ]);
    prisma.warehouse.findMany.mockResolvedValueOnce([{ id: WAREHOUSE_ID }]);
    const res = await service.getLinkedCounts(ORG, [DOC_ID]);
    expect(res[DOC_ID]).toEqual({ purchaseOrder: 0, warehouses: 1 });
  });

  // Item 1: TRANSFER з живим джерелом+PO, але soft-deleted ЛИШЕ target → warehouses=1 (НЕ 2).
  // Ізолює вплив target-liveness від PO/source (на відміну від змішаного тесту вище).
  it('getLinkedCounts: TRANSFER із soft-deleted ЛИШЕ target-складом → warehouses=1 (не 2)', async () => {
    prisma.stockDocument.findMany.mockResolvedValueOnce([
      {
        id: DOC_ID,
        purchaseOrderId: PO_ID,
        warehouseId: WAREHOUSE_ID,
        targetWarehouseId: TARGET_WAREHOUSE_ID,
      },
    ]);
    // PO живий, джерело живе, target soft-deleted (не в liveWhSet).
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([{ id: PO_ID }]);
    prisma.warehouse.findMany.mockResolvedValueOnce([{ id: WAREHOUSE_ID }]);
    const res = await service.getLinkedCounts(ORG, [DOC_ID]);
    expect(res[DOC_ID]).toEqual({ purchaseOrder: 1, warehouses: 1 });
  });
});

/**
 * Phase D2 — опціональний PO-джерело у create(). Персистенція + FK-guard.
 */
