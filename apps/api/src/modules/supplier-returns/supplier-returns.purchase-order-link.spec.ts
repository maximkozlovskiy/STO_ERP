/**
 * SupplierReturnsService — purchaseOrderId на create і update (Phase D2)
 *
 * Виділено з `supplier-returns.service.spec.ts` (був 913 рядків, 5 незалежних
 * top-level describe) 2026-10-05. Кейси перенесені ДОСЛІВНО, назви describe не
 * змінені — інакше `fullName` у test-baseline.json розійшовся б.
 */

import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { SupplierReturnStatus } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SupplierReturnsService } from './supplier-returns.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DocumentNumberService } from '../document-number/document-number.service';

describe('SupplierReturnsService — create() з purchaseOrderId (Phase D2)', () => {
  let service: SupplierReturnsService;
  let prisma: {
    supplierReturn: { create: ReturnType<typeof vi.fn> };
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    warehouse: { findFirst: ReturnType<typeof vi.fn> };
    good: { findMany: ReturnType<typeof vi.fn> };
    unitOfMeasure: { findMany: ReturnType<typeof vi.fn> };
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn> };
  };
  let docNumbers: { next: ReturnType<typeof vi.fn> };

  const ORG = '00000000-0000-4000-8000-000000000001';
  const SR_ID = '11111111-1111-4111-8111-111111111111';
  const SUPPLIER_ID = '22222222-2222-4222-8222-222222222222';
  const WAREHOUSE_ID = '33333333-3333-4333-8333-333333333333';
  const PO_ID = '99999999-9999-4999-8999-999999999999';

  const buildReturnDoc = (purchaseOrderId: string | null) => ({
    id: SR_ID,
    orgId: ORG,
    number: 'ПВП-20260615-000001',
    status: SupplierReturnStatus.DRAFT,
    supplierId: SUPPLIER_ID,
    warehouseId: WAREHOUSE_ID,
    purchaseOrderId,
    totalAmount: 0,
    notes: null,
    documentDate: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    supplier: { firstName: null, lastName: null, companyName: 'ТОВ Постач' },
    warehouse: { name: 'Склад 1' },
    purchaseOrder: purchaseOrderId ? { number: 'ЗП-2026-0007' } : null,
    lines: [],
  });

  beforeEach(async () => {
    prisma = {
      supplierReturn: { create: vi.fn() },
      counterparty: { findFirst: vi.fn().mockResolvedValue({ id: SUPPLIER_ID }) },
      warehouse: { findFirst: vi.fn().mockResolvedValue({ id: WAREHOUSE_ID }) },
      good: { findMany: vi.fn().mockResolvedValue([]) },
      unitOfMeasure: { findMany: vi.fn().mockResolvedValue([]) },
      purchaseOrder: { findFirst: vi.fn() },
    };
    docNumbers = { next: vi.fn().mockResolvedValue('ПВП-20260615-000001') };

    const module = await Test.createTestingModule({
      providers: [
        SupplierReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: {} },
        { provide: SettlementsService, useValue: {} },
        { provide: DocumentNumberService, useValue: docNumbers },
      ],
    }).compile();
    service = module.get(SupplierReturnsService);
  });

  it('create() з валідним purchaseOrderId → персистить purchaseOrderId + повертає у DTO', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ id: PO_ID });
    prisma.supplierReturn.create.mockResolvedValueOnce(buildReturnDoc(PO_ID));

    const res = await service.create(ORG, {
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      purchaseOrderId: PO_ID,
    } as never);

    expect(prisma.purchaseOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PO_ID, orgId: ORG, deletedAt: null } }),
    );
    expect(prisma.supplierReturn.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ purchaseOrderId: PO_ID }) }),
    );
    expect(res.purchaseOrderId).toBe(PO_ID);
    expect(res.purchaseOrderNumber).toBe('ЗП-2026-0007');
  });

  it('create() без purchaseOrderId → persist null; FK-guard не викликається', async () => {
    prisma.supplierReturn.create.mockResolvedValueOnce(buildReturnDoc(null));

    const res = await service.create(ORG, {
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
    } as never);

    expect(prisma.purchaseOrder.findFirst).not.toHaveBeenCalled();
    expect(prisma.supplierReturn.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ purchaseOrderId: null }) }),
    );
    expect(res.purchaseOrderId).toBeNull();
  });

  it('create() з невалідним purchaseOrderId → BadRequestException; create не викликається', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.create(ORG, {
        supplierId: SUPPLIER_ID,
        warehouseId: WAREHOUSE_ID,
        purchaseOrderId: PO_ID,
      } as never),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.supplierReturn.create).not.toHaveBeenCalled();
  });
});

/**
 * Phase D2 — edit-path НЕ чіпає purchaseOrderId (FK-джерело зберігається).
 * UpdateSupplierReturnDto навмисно НЕ має поля purchaseOrderId (create-only персистенція).
 * Регресія: якщо update().data почне писати purchaseOrderId → редагування чернетки
 * знулило б джерело-замовлення. Контракт: update().data НЕ містить ключа purchaseOrderId.
 */

describe('SupplierReturnsService — update() зберігає purchaseOrderId (Phase D2)', () => {
  let service: SupplierReturnsService;
  let updateData: Record<string, unknown> | undefined;
  let prisma: {
    supplierReturn: {
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    supplierReturnLine: {
      updateMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    warehouse: { findFirst: ReturnType<typeof vi.fn> };
    good: { findMany: ReturnType<typeof vi.fn> };
    unitOfMeasure: { findMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };

  const ORG = '00000000-0000-4000-8000-000000000001';
  const SR_ID = '11111111-1111-4111-8111-111111111111';
  const PO_ID = '99999999-9999-4999-8999-999999999999';

  beforeEach(async () => {
    updateData = undefined;
    prisma = {
      supplierReturn: {
        findFirst: vi
          .fn()
          // update() pre-guard (status DRAFT)
          .mockResolvedValueOnce({ id: SR_ID, status: SupplierReturnStatus.DRAFT })
          // findOne() у кінці update
          .mockResolvedValueOnce({
            id: SR_ID,
            orgId: ORG,
            number: 'ПВП-20260615-000001',
            status: SupplierReturnStatus.DRAFT,
            supplierId: 's1',
            warehouseId: 'w1',
            purchaseOrderId: PO_ID, // ← FK лишається
            totalAmount: 0,
            notes: 'нове',
            documentDate: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
            supplier: { firstName: null, lastName: null, companyName: 'Acme' },
            warehouse: { name: 'С1' },
            purchaseOrder: { number: 'ЗП-2026-0007' },
            lines: [],
          }),
        update: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          updateData = args.data;
          return Promise.resolve({});
        }),
      },
      supplierReturnLine: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      counterparty: { findFirst: vi.fn() },
      warehouse: { findFirst: vi.fn() },
      good: { findMany: vi.fn().mockResolvedValue([]) },
      unitOfMeasure: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
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

  it('update() НЕ передає purchaseOrderId у data → FK зберігається; DTO повертає існуючий PO', async () => {
    const res = await service.update(ORG, SR_ID, { notes: 'нове' } as never);

    expect(updateData).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(updateData!, 'purchaseOrderId')).toBe(false);
    expect(res.purchaseOrderId).toBe(PO_ID);
    expect(res.purchaseOrderNumber).toBe('ЗП-2026-0007');
  });
});
