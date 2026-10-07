/**
 * StockDocumentsService — create()/update() зберігають purchaseOrderId (Phase D2)
 *
 * Виділено з `stock-documents.service.spec.ts` (був 1040 рядків, 4 незалежні
 * top-level describe) 2026-10-05. Кейси перенесені ДОСЛІВНО, назви describe
 * не змінені — інакше `fullName` у test-baseline.json розійшовся б.
 */

import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { StockDocumentType } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { StockDocumentsService } from './stock-documents.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { DocumentNumberService } from '../document-number/document-number.service';

describe('StockDocumentsService — create() з purchaseOrderId (Phase D2)', () => {
  let service: StockDocumentsService;
  let prisma: {
    stockDocument: {
      create: ReturnType<typeof vi.fn>;
      findFirstOrThrow: ReturnType<typeof vi.fn>;
    };
    stockDocumentLine: { createMany: ReturnType<typeof vi.fn> };
    garageBranch: { findFirst: ReturnType<typeof vi.fn> };
    warehouse: { findFirst: ReturnType<typeof vi.fn> };
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let docNumbers: { next: ReturnType<typeof vi.fn> };

  const ORG = 'org-1';
  const DOC_ID = '11111111-1111-4111-8111-111111111111';
  const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
  const WAREHOUSE_ID = '33333333-3333-4333-8333-333333333333';
  const PO_ID = '99999999-9999-4999-8999-999999999999';

  const buildReturnDoc = (purchaseOrderId: string | null) => ({
    id: DOC_ID,
    orgId: ORG,
    number: 'ПТ-2026-0001',
    type: StockDocumentType.RECEIPT,
    status: 'DRAFT',
    branchId: BRANCH_ID,
    warehouseId: WAREHOUSE_ID,
    targetWarehouseId: null,
    purchaseOrderId,
    notes: null,
    documentDate: new Date(),
    confirmedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    branch: { name: 'Філія 1' },
    warehouse: { name: 'Склад 1' },
    targetWarehouse: null,
    purchaseOrder: purchaseOrderId ? { number: 'ЗП-2026-0007' } : null,
    lines: [],
  });

  beforeEach(async () => {
    prisma = {
      stockDocument: { create: vi.fn(), findFirstOrThrow: vi.fn() },
      stockDocumentLine: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: BRANCH_ID }) },
      warehouse: { findFirst: vi.fn().mockResolvedValue({ id: WAREHOUSE_ID }) },
      purchaseOrder: { findFirst: vi.fn() },
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
    };
    docNumbers = { next: vi.fn().mockResolvedValue('ПТ-2026-0001') };

    const module = await Test.createTestingModule({
      providers: [
        StockDocumentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: {} },
        { provide: DocumentNumberService, useValue: docNumbers },
      ],
    }).compile();
    service = module.get(StockDocumentsService);
  });

  // guards: BR-SDOC-006
  it('create() з валідним purchaseOrderId → персистить purchaseOrderId у data + повертає у DTO', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ id: PO_ID });
    prisma.stockDocument.create.mockResolvedValueOnce({ id: DOC_ID });
    prisma.stockDocument.findFirstOrThrow.mockResolvedValueOnce(buildReturnDoc(PO_ID));

    const res = await service.create(ORG, {
      type: 'RECEIPT',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      purchaseOrderId: PO_ID,
    } as never);

    expect(prisma.purchaseOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PO_ID, orgId: ORG, deletedAt: null } }),
    );
    expect(prisma.stockDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ purchaseOrderId: PO_ID }),
      }),
    );
    expect(res.purchaseOrderId).toBe(PO_ID);
    expect(res.purchaseOrderNumber).toBe('ЗП-2026-0007');
  });

  // guards: BR-SDOC-006
  it('create() без purchaseOrderId → persist null; FK-guard не викликається', async () => {
    prisma.stockDocument.create.mockResolvedValueOnce({ id: DOC_ID });
    prisma.stockDocument.findFirstOrThrow.mockResolvedValueOnce(buildReturnDoc(null));

    const res = await service.create(ORG, {
      type: 'RECEIPT',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
    } as never);

    expect(prisma.purchaseOrder.findFirst).not.toHaveBeenCalled();
    expect(prisma.stockDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ purchaseOrderId: null }) }),
    );
    expect(res.purchaseOrderId).toBeNull();
  });

  // guards: BR-SDOC-006
  it('create() з невалідним purchaseOrderId (чужа org / soft-deleted) → BadRequestException', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.create(ORG, {
        type: 'RECEIPT',
        branchId: BRANCH_ID,
        warehouseId: WAREHOUSE_ID,
        purchaseOrderId: PO_ID,
      } as never),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.stockDocument.create).not.toHaveBeenCalled();
  });
});

/**
 * Phase D2 — edit-path НЕ чіпає purchaseOrderId (FK-джерело зберігається).
 * UpdateStockDocumentDto навмисно НЕ має поля purchaseOrderId (create-only персистенція).
 * Регресія: якщо хтось додасть purchaseOrderId у update().data (напр. копі-паст з create),
 * PATCH без цього поля → Prisma отримає undefined → у поточному коді FK лишається, але
 * якщо його поставлять як `purchaseOrderId: dto.purchaseOrderId ?? null` → редагування
 * чернетки НУЛИТЬ джерело-замовлення. Цей тест фіксує контракт: update().data НЕ містить
 * ключа purchaseOrderId взагалі.
 */

describe('StockDocumentsService — update() зберігає purchaseOrderId (Phase D2)', () => {
  let service: StockDocumentsService;
  let updateData: Record<string, unknown> | undefined;
  let prisma: {
    stockDocument: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    stockDocumentLine: {
      updateMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };

  const ORG = 'org-1';
  const DOC_ID = '11111111-1111-4111-8111-111111111111';
  const PO_ID = '99999999-9999-4999-8999-999999999999';

  beforeEach(async () => {
    updateData = undefined;
    prisma = {
      stockDocument: {
        findFirst: vi.fn().mockResolvedValue({ status: 'DRAFT' }),
        update: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          updateData = args.data;
          return Promise.resolve({
            id: DOC_ID,
            orgId: ORG,
            number: 'ПТ-2026-0001',
            type: StockDocumentType.RECEIPT,
            status: 'DRAFT',
            branchId: 'b1',
            warehouseId: 'w1',
            targetWarehouseId: null,
            purchaseOrderId: PO_ID, // ← FK лишається у поверненому рядку
            notes: 'нове',
            documentDate: new Date(),
            confirmedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            branch: { name: 'Ф1' },
            warehouse: { name: 'С1' },
            targetWarehouse: null,
            purchaseOrder: { number: 'ЗП-2026-0007' },
            lines: [],
          });
        }),
      },
      stockDocumentLine: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
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

  // guards: BR-SDOC-006
  it('update() НЕ передає purchaseOrderId у data → FK зберігається; DTO повертає існуючий PO', async () => {
    const res = await service.update(ORG, DOC_ID, { notes: 'нове' } as never);

    // КРИТИЧНИЙ дискримінатор: update.data не має ключа purchaseOrderId (жодного нулювання).
    expect(updateData).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(updateData!, 'purchaseOrderId')).toBe(false);
    // FK зберігся → DTO віддає існуюче джерело-замовлення.
    expect(res.purchaseOrderId).toBe(PO_ID);
    expect(res.purchaseOrderNumber).toBe('ЗП-2026-0007');
  });
});
