import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SupplierReturnStatus, StockMovementType } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SupplierReturnsService } from './supplier-returns.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DocumentNumberService } from '../document-number/document-number.service';

// Regression-guards для feature "Повернення постачальнику" (commits 28edc08c + 9e656cd4).
// Перевіряє ключові business invariants на confirm()/cancel() FSM-step:
//   1. confirm() створює WRITEOFF з НЕГАТИВНОЮ quantity (декремент стоку).
//   2. confirm() створює REFUND settlement transaction (НЕ PAYMENT, НЕ CHARGE).
//   3. confirm() без рядків → BadRequestException; жодних side-effects.
//   4. confirm() з non-DRAFT статусу → BadRequestException.
//   5. documentType передається як 'SupplierReturn' (PascalCase model-name convention),
//      НЕ як enum value 'SUPPLIER_RETURN'.
//   6. Duplicate goodId дедуплікується через deduplicateBy → 1 запис у БД, не 2.
//   7. cancel() з DRAFT → CANCELLED; cancel() з CONFIRMED → BadRequestException.
//   8. Cross-tenant FK guard (Bug #495): goodId з чужої org → NotFoundException.
//
// Без unit-тесту ці інваріанти покриті тільки E2E (повільно + flaky без Postgres) →
// тестер ловить силенту регресію (наприклад refactor що змінює знак quantity або
// type REFUND→PAYMENT) лише на проді.
describe('SupplierReturnsService — regression guards', () => {
  let service: SupplierReturnsService;
  let prisma: {
    supplierReturn: {
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
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
  let inventory: { createMovement: ReturnType<typeof vi.fn> };
  let settlements: { createTransaction: ReturnType<typeof vi.fn> };
  let docNumbers: { next: ReturnType<typeof vi.fn> };

  const ORG = '00000000-0000-0000-0000-000000000001';
  const SR_ID = '11111111-1111-4111-8111-111111111111';
  const SUPPLIER_ID = '22222222-2222-4222-8222-222222222222';
  const WAREHOUSE_ID = '33333333-3333-4333-8333-333333333333';
  const GOOD_ID = '44444444-4444-4444-8444-444444444444';
  const GOOD_ID_2 = '55555555-5555-4555-8555-555555555555';
  const UOM_ID = '66666666-6666-4666-8666-666666666666';
  const USER_ID = '77777777-7777-4777-8777-777777777777';

  beforeEach(async () => {
    prisma = {
      supplierReturn: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
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
        if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
    };
    inventory = { createMovement: vi.fn().mockResolvedValue(undefined) };
    settlements = { createTransaction: vi.fn().mockResolvedValue(undefined) };
    docNumbers = { next: vi.fn().mockResolvedValue('ПВП-20260615-000001') };

    const module = await Test.createTestingModule({
      providers: [
        SupplierReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: inventory },
        { provide: SettlementsService, useValue: settlements },
        { provide: DocumentNumberService, useValue: docNumbers },
      ],
    }).compile();
    service = module.get(SupplierReturnsService);
  });

  // ──────────────────────────────────────────────────────────────────────
  // confirm() — головний FSM-step
  // ──────────────────────────────────────────────────────────────────────

  it('confirm(): WRITEOFF викликаний з НЕГАТИВНОЮ quantity + documentType=SupplierReturn (PascalCase)', async () => {
    // pre-check
    prisma.supplierReturn.findFirst.mockResolvedValueOnce({
      status: SupplierReturnStatus.DRAFT,
      _count: { lines: 1 },
    });
    // re-read у $tx
    prisma.supplierReturn.findFirst.mockResolvedValueOnce({
      status: SupplierReturnStatus.DRAFT,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      totalAmount: 250,
      lines: [{ goodId: GOOD_ID, quantity: 5, price: 50, unitOfMeasureId: UOM_ID }],
    });
    // findOne() у кінці confirm для повернення dto
    prisma.supplierReturn.findFirst.mockResolvedValueOnce({
      id: SR_ID,
      orgId: ORG,
      number: 'ПВП-20260615-000001',
      status: SupplierReturnStatus.CONFIRMED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      totalAmount: 250,
      notes: null,
      documentDate: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      supplier: { firstName: null, lastName: null, companyName: 'Acme' },
      warehouse: { name: 'Склад 1' },
      lines: [],
    });

    await service.confirm(ORG, SR_ID, USER_ID);

    // Інваріант 1: createMovement викликаний РІВНО ОДИН раз.
    expect(inventory.createMovement).toHaveBeenCalledTimes(1);
    const [orgArg, dtoArg] = inventory.createMovement.mock.calls[0]!;
    expect(orgArg).toBe(ORG);

    // Інваріант 2: type = WRITEOFF.
    expect(dtoArg).toMatchObject({
      goodId: GOOD_ID,
      warehouseId: WAREHOUSE_ID,
      type: 'WRITEOFF' satisfies StockMovementType,
      price: 50,
      // Інваріант 3: documentType = 'SupplierReturn' (PascalCase model-name), НЕ 'SUPPLIER_RETURN'.
      documentType: 'SupplierReturn',
      documentId: SR_ID,
      createdBy: USER_ID,
      unitOfMeasureId: UOM_ID,
    });
    // Інваріант 4: quantity НЕГАТИВНА (декремент стоку).
    // Без цього commit 9e656cd4 fix відмінив би себе → confirm() ІНКРЕМЕНТУВАЛО б stock
    // замість декрементувати → реальний bug.
    expect(dtoArg.quantity).toBe(-5);
    expect(dtoArg.quantity).toBeLessThan(0);
  });

  it('confirm(): settlement transaction створюється з type=REFUND (НЕ PAYMENT, НЕ CHARGE)', async () => {
    prisma.supplierReturn.findFirst
      .mockResolvedValueOnce({ status: SupplierReturnStatus.DRAFT, _count: { lines: 1 } })
      .mockResolvedValueOnce({
        status: SupplierReturnStatus.DRAFT,
        supplierId: SUPPLIER_ID,
        warehouseId: WAREHOUSE_ID,
        totalAmount: 1000,
        lines: [{ goodId: GOOD_ID, quantity: 10, price: 100, unitOfMeasureId: null }],
      })
      .mockResolvedValueOnce({
        id: SR_ID,
        orgId: ORG,
        number: 'ПВП-20260615-000001',
        status: SupplierReturnStatus.CONFIRMED,
        supplierId: SUPPLIER_ID,
        warehouseId: WAREHOUSE_ID,
        totalAmount: 1000,
        notes: null,
        documentDate: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        supplier: { firstName: null, lastName: null, companyName: 'Acme' },
        warehouse: { name: 'Склад 1' },
        lines: [],
      });

    await service.confirm(ORG, SR_ID, USER_ID);

    expect(settlements.createTransaction).toHaveBeenCalledTimes(1);
    const [orgArg, dtoArg] = settlements.createTransaction.mock.calls[0]!;
    expect(orgArg).toBe(ORG);
    expect(dtoArg).toMatchObject({
      counterpartyId: SUPPLIER_ID,
      // SUPPLIER_REFUND (+1): повернули товар постачальнику → наш борг перед ним ↓.
      // НЕ REFUND (−1, збільшив би наш борг) і НЕ PAYMENT.
      type: 'SUPPLIER_REFUND',
      amount: 1000,
      documentType: 'SupplierReturn',
      documentId: SR_ID,
      createdBy: USER_ID,
    });
    // Захист від випадкового refactor type → 'PAYMENT' / 'CHARGE'.
    expect(dtoArg.type).not.toBe('PAYMENT');
    expect(dtoArg.type).not.toBe('CHARGE');
  });

  it('confirm() без рядків (pre-check) → BadRequestException; жодних side-effects', async () => {
    prisma.supplierReturn.findFirst.mockResolvedValueOnce({
      status: SupplierReturnStatus.DRAFT,
      _count: { lines: 0 },
    });

    await expect(service.confirm(ORG, SR_ID, USER_ID)).rejects.toThrow(BadRequestException);
    expect(inventory.createMovement).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
    expect(prisma.supplierReturn.update).not.toHaveBeenCalled();
  });

  it('confirm() зі статусу CONFIRMED → BadRequestException + не запускає $tx', async () => {
    prisma.supplierReturn.findFirst.mockResolvedValueOnce({
      status: SupplierReturnStatus.CONFIRMED,
      _count: { lines: 3 },
    });

    await expect(service.confirm(ORG, SR_ID, USER_ID)).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(inventory.createMovement).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
  });

  it('confirm() зі статусу CANCELLED → BadRequestException', async () => {
    prisma.supplierReturn.findFirst.mockResolvedValueOnce({
      status: SupplierReturnStatus.CANCELLED,
      _count: { lines: 1 },
    });

    await expect(service.confirm(ORG, SR_ID, USER_ID)).rejects.toThrow(BadRequestException);
    expect(inventory.createMovement).not.toHaveBeenCalled();
  });

  it('confirm() не існує → NotFoundException', async () => {
    prisma.supplierReturn.findFirst.mockResolvedValueOnce(null);

    await expect(service.confirm(ORG, SR_ID, USER_ID)).rejects.toThrow(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('confirm() з totalAmount=0 → НЕ створює settlement transaction (guard рядок 336)', async () => {
    prisma.supplierReturn.findFirst
      .mockResolvedValueOnce({ status: SupplierReturnStatus.DRAFT, _count: { lines: 1 } })
      .mockResolvedValueOnce({
        status: SupplierReturnStatus.DRAFT,
        supplierId: SUPPLIER_ID,
        warehouseId: WAREHOUSE_ID,
        totalAmount: 0,
        lines: [{ goodId: GOOD_ID, quantity: 1, price: 0, unitOfMeasureId: null }],
      })
      .mockResolvedValueOnce({
        id: SR_ID,
        orgId: ORG,
        number: 'ПВП-20260615-000001',
        status: SupplierReturnStatus.CONFIRMED,
        supplierId: SUPPLIER_ID,
        warehouseId: WAREHOUSE_ID,
        totalAmount: 0,
        notes: null,
        documentDate: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        supplier: { firstName: null, lastName: null, companyName: 'Acme' },
        warehouse: { name: 'Склад 1' },
        lines: [],
      });

    await service.confirm(ORG, SR_ID, USER_ID);

    expect(inventory.createMovement).toHaveBeenCalledTimes(1);
    // Settlement skipped — повернення безкоштовного зразка (нічого не повертати).
    expect(settlements.createTransaction).not.toHaveBeenCalled();
  });

  it('confirm() з concurrent-double-call: re-read у $tx ловить зміну статусу → BadRequestException', async () => {
    // Симулюємо race: pre-check бачить DRAFT, але між pre-check і відкриттям $tx
    // паралельний confirm() уже переключив на CONFIRMED.
    prisma.supplierReturn.findFirst
      .mockResolvedValueOnce({ status: SupplierReturnStatus.DRAFT, _count: { lines: 1 } })
      // Re-read у $tx бачить уже CONFIRMED.
      .mockResolvedValueOnce({
        status: SupplierReturnStatus.CONFIRMED,
        supplierId: SUPPLIER_ID,
        warehouseId: WAREHOUSE_ID,
        totalAmount: 100,
        lines: [{ goodId: GOOD_ID, quantity: 1, price: 100, unitOfMeasureId: null }],
      });

    // Очікуємо BadRequestException з re-check у $tx (рядок 306-310 service).
    // Без цього re-check два concurrent confirm() дали б подвійний WRITEOFF + REFUND.
    await expect(service.confirm(ORG, SR_ID, USER_ID)).rejects.toThrow(BadRequestException);
    expect(inventory.createMovement).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────
  // cancel()
  // ──────────────────────────────────────────────────────────────────────

  it('cancel() з DRAFT → status=CANCELLED', async () => {
    prisma.supplierReturn.findFirst
      .mockResolvedValueOnce({ id: SR_ID, status: SupplierReturnStatus.DRAFT })
      // findOne у кінці cancel
      .mockResolvedValueOnce({
        id: SR_ID,
        orgId: ORG,
        number: 'ПВП-20260615-000001',
        status: SupplierReturnStatus.CANCELLED,
        supplierId: SUPPLIER_ID,
        warehouseId: WAREHOUSE_ID,
        totalAmount: 0,
        notes: null,
        documentDate: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        supplier: { firstName: null, lastName: null, companyName: 'Acme' },
        warehouse: { name: 'Склад 1' },
        lines: [],
      });

    await service.cancel(ORG, SR_ID);

    expect(prisma.supplierReturn.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: SR_ID, orgId: ORG },
        data: { status: SupplierReturnStatus.CANCELLED },
      }),
    );
    // cancel НЕ створює інвентарних рухів (товари ще не списані).
    expect(inventory.createMovement).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
  });

  it('cancel() з CONFIRMED → BadRequestException (FSM правило)', async () => {
    prisma.supplierReturn.findFirst.mockResolvedValueOnce({
      id: SR_ID,
      status: SupplierReturnStatus.CONFIRMED,
    });

    await expect(service.cancel(ORG, SR_ID)).rejects.toThrow(BadRequestException);
    expect(prisma.supplierReturn.update).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────
  // create() — deduplication + cross-tenant FK guards
  // ──────────────────────────────────────────────────────────────────────

  it('create() з дублікатним goodId у lines → дедуплікація через deduplicateBy (1 рядок створено)', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: SUPPLIER_ID });
    prisma.warehouse.findFirst.mockResolvedValueOnce({ id: WAREHOUSE_ID });
    prisma.good.findMany.mockResolvedValueOnce([{ id: GOOD_ID }]);
    prisma.supplierReturn.create.mockResolvedValueOnce({
      id: SR_ID,
      orgId: ORG,
      number: 'ПВП-20260615-000001',
      status: SupplierReturnStatus.DRAFT,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      totalAmount: 50, // last-write-wins: qty=2, price=25 → 50
      notes: null,
      documentDate: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      supplier: { firstName: null, lastName: null, companyName: 'Acme' },
      warehouse: { name: 'Склад 1' },
      lines: [],
    });

    await service.create(ORG, {
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      lines: [
        { goodId: GOOD_ID, quantity: 1, price: 10 },
        { goodId: GOOD_ID, quantity: 2, price: 25 }, // дубль → last-write-wins
      ],
    });

    // Перевірка дедуплікації: у Prisma create.data.lines.create має бути лише 1 запис
    // з останніми значеннями (qty=2, price=25 → totalAmount=50).
    const callArg = prisma.supplierReturn.create.mock.calls[0]![0] as {
      data: { lines: { create: Array<{ goodId: string; quantity: number; price: number }> } };
    };
    const createdLines = callArg.data.lines.create;
    expect(createdLines).toHaveLength(1);
    expect(createdLines[0]).toMatchObject({ goodId: GOOD_ID, quantity: 2, price: 25 });
    // totalAmount теж порахований на дедуплікованому списку → 2 * 25 = 50, НЕ 1*10+2*25=60.
    expect(callArg.data).toMatchObject({ totalAmount: 50 });
  });

  it('create(): cross-tenant goodId → NotFoundException (Bug #495 guard)', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: SUPPLIER_ID });
    prisma.warehouse.findFirst.mockResolvedValueOnce({ id: WAREHOUSE_ID });
    // good.findMany повертає тільки 1 з 2 — другий goodId з чужої org.
    prisma.good.findMany.mockResolvedValueOnce([{ id: GOOD_ID }]);

    await expect(
      service.create(ORG, {
        supplierId: SUPPLIER_ID,
        warehouseId: WAREHOUSE_ID,
        lines: [
          { goodId: GOOD_ID, quantity: 1, price: 10 },
          { goodId: GOOD_ID_2, quantity: 1, price: 10 }, // cross-tenant
        ],
      }),
    ).rejects.toThrow(NotFoundException);
    // Жодного запису не створено.
    expect(prisma.supplierReturn.create).not.toHaveBeenCalled();
  });

  it('create(): cross-tenant unitOfMeasureId → NotFoundException', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: SUPPLIER_ID });
    prisma.warehouse.findFirst.mockResolvedValueOnce({ id: WAREHOUSE_ID });
    prisma.good.findMany.mockResolvedValueOnce([{ id: GOOD_ID }]);
    // uom.findMany повертає 0 — наданий UoM з чужої org.
    prisma.unitOfMeasure.findMany.mockResolvedValueOnce([]);

    await expect(
      service.create(ORG, {
        supplierId: SUPPLIER_ID,
        warehouseId: WAREHOUSE_ID,
        lines: [{ goodId: GOOD_ID, quantity: 1, price: 10, unitOfMeasureId: UOM_ID }],
      }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.supplierReturn.create).not.toHaveBeenCalled();
  });

  it('create() з неіснуючим supplierId → NotFoundException', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce(null);
    prisma.warehouse.findFirst.mockResolvedValueOnce({ id: WAREHOUSE_ID });

    await expect(
      service.create(ORG, { supplierId: SUPPLIER_ID, warehouseId: WAREHOUSE_ID, lines: [] }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.supplierReturn.create).not.toHaveBeenCalled();
  });

  it('create() з неіснуючим warehouseId → NotFoundException', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: SUPPLIER_ID });
    prisma.warehouse.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.create(ORG, { supplierId: SUPPLIER_ID, warehouseId: WAREHOUSE_ID, lines: [] }),
    ).rejects.toThrow(NotFoundException);
  });
});

/**
 * Phase D3 — «Пов'язані документи» повернення постачальнику (getLinkedDocuments/getLinkedCounts).
 * Дзеркалить Counterparty-патерн: orgId+deletedAt:null, Decimal→Number, zero-init counts.
 * Bug #641 lesson: count має рахувати те саме, що бачить detail (deletedAt:null скрізь).
 */
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

  const ORG = '00000000-0000-0000-0000-000000000001';
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

  const ORG = '00000000-0000-0000-0000-000000000001';
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
