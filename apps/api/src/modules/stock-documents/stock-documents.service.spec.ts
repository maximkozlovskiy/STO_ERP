import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StockDocumentType, StockMovementType, DocumentType } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { StockDocumentsService } from './stock-documents.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { DocumentNumberService } from '../document-number/document-number.service';

// Bug #480: regression-guards для нового StockDocumentType.RECEIPT (commits d059b9a9 + a067ec21).
// Перевіряє три інваріанти що легко силенто зламати при refactor MOVEMENT_TYPES / docTypeMap:
//   1. transition(RECEIPT-doc → CONFIRMED) НЕ кидає "Непідтримуваний тип документу" —
//      MOVEMENT_TYPES['RECEIPT'] = StockMovementType.RECEIPT (рядок 31 service).
//   2. RECEIPT іде у else-гілку (НЕ TRANSFER) — викликає inventory.createMovement ОДИН раз
//      з warehouseId=doc.warehouseId (НЕ потребує targetWarehouseId).
//   3. quantity передається ПОЗИТИВНОЮ (інкремент) — рядок 358 service:
//      `doc.type === 'WRITEOFF' ? -line.quantity : line.quantity`.
// Парне з contract Bug #478-#479. Без unit-тесту RECEIPT логіка покрита тільки E2E
// (повільно + потребує DB + flaky на CI без Postgres).
describe('StockDocumentsService — RECEIPT type (Bug #480 regression guard)', () => {
  let service: StockDocumentsService;
  let prisma: {
    stockDocument: {
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      findFirstOrThrow: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    stockDocumentLine: {
      update: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    garageBranch: { findFirst: ReturnType<typeof vi.fn> };
    warehouse: { findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let inventory: { createMovement: ReturnType<typeof vi.fn> };
  let docNumbers: { next: ReturnType<typeof vi.fn> };

  const ORG = 'org-1';
  const DOC_ID = '11111111-1111-4111-8111-111111111111';
  const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
  const WAREHOUSE_ID = '33333333-3333-4333-8333-333333333333';
  const GOOD_ID = '44444444-4444-4444-8444-444444444444';
  const LINE_ID = '55555555-5555-4555-8555-555555555555';
  const UNIT_ID = '66666666-6666-4666-8666-666666666666';

  beforeEach(async () => {
    prisma = {
      stockDocument: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        findFirstOrThrow: vi.fn(),
        create: vi.fn(),
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      stockDocumentLine: {
        update: vi.fn().mockResolvedValue({}),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      garageBranch: { findFirst: vi.fn() },
      warehouse: { findFirst: vi.fn() },
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
    };
    inventory = { createMovement: vi.fn().mockResolvedValue(undefined) };
    docNumbers = { next: vi.fn().mockResolvedValue('ПТ-2026-0001') };

    const module = await Test.createTestingModule({
      providers: [
        StockDocumentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: inventory },
        { provide: DocumentNumberService, useValue: docNumbers },
      ],
    }).compile();
    service = module.get(StockDocumentsService);
  });

  // ──────────────────────────────────────────────────────────────────────
  // create()
  // ──────────────────────────────────────────────────────────────────────

  it('create(): type=RECEIPT не вимагає targetWarehouseId; docNumbers.next отримує STOCK_RECEIPT', async () => {
    prisma.garageBranch.findFirst.mockResolvedValueOnce({ id: BRANCH_ID });
    prisma.warehouse.findFirst.mockResolvedValueOnce({ id: WAREHOUSE_ID });
    prisma.stockDocument.create.mockResolvedValueOnce({ id: DOC_ID });
    prisma.stockDocument.findFirstOrThrow.mockResolvedValueOnce({
      id: DOC_ID,
      orgId: ORG,
      number: 'ПТ-2026-0001',
      type: StockDocumentType.RECEIPT,
      status: 'DRAFT',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: null,
      notes: null,
      documentDate: new Date(),
      confirmedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      branch: { name: 'Філія 1' },
      warehouse: { name: 'Склад 1' },
      targetWarehouse: null,
      lines: [],
    });

    const dto = {
      type: 'RECEIPT',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      lines: [{ goodId: GOOD_ID, quantity: 5, price: 100 }],
    };
    const res = await service.create(ORG, dto as never);

    // DocumentNumberService має отримати саме STOCK_RECEIPT (Bug #480: docTypeMap['RECEIPT']).
    expect(docNumbers.next).toHaveBeenCalledWith(ORG, 'STOCK_RECEIPT' satisfies DocumentType);
    expect(res.type).toBe(StockDocumentType.RECEIPT);
    // targetWarehouseId не запитувався — RECEIPT не вимагає (на відміну від TRANSFER).
    expect(prisma.warehouse.findFirst).toHaveBeenCalledTimes(1);
  });

  // ──────────────────────────────────────────────────────────────────────
  // transition(RECEIPT → CONFIRMED)
  // ──────────────────────────────────────────────────────────────────────

  it('transition(RECEIPT → CONFIRMED): inventory.createMovement викликаний ОДИН раз з type=RECEIPT і ПОЗИТИВНОЮ quantity', async () => {
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      orgId: ORG,
      number: 'ПТ-2026-0001',
      type: StockDocumentType.RECEIPT,
      status: 'DRAFT',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: null,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 7,
          price: 100,
          good: { unitId: UNIT_ID },
        },
      ],
    });
    // findOne у кінці transition (return this.findOne) — повертає мінімально валідний doc.
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      orgId: ORG,
      number: 'ПТ-2026-0001',
      type: StockDocumentType.RECEIPT,
      status: 'CONFIRMED',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: null,
      notes: null,
      documentDate: new Date(),
      confirmedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      branch: { name: 'Філія 1' },
      warehouse: { name: 'Склад 1' },
      targetWarehouse: null,
      lines: [],
    });

    await service.transition(ORG, DOC_ID, 'CONFIRMED', 'user-1');

    // ────────────────────────────────────────────────────────
    // Інваріант 1: createMovement викликаний РІВНО ОДИН раз (НЕ як TRANSFER з двома).
    expect(inventory.createMovement).toHaveBeenCalledTimes(1);
    const [orgArg, dtoArg] = inventory.createMovement.mock.calls[0]!;
    expect(orgArg).toBe(ORG);
    // Інваріант 2: type === RECEIPT (НЕ WRITEOFF, не undefined → НЕ кидає
    // "Непідтримуваний тип документу").
    expect(dtoArg).toMatchObject({
      goodId: GOOD_ID,
      warehouseId: WAREHOUSE_ID,
      type: StockMovementType.RECEIPT,
      // Інваріант 3: quantity > 0 (інкремент стоку), price передано, UoM передано.
      quantity: 7,
      price: 100,
      documentType: 'StockDocument',
      documentId: DOC_ID,
      createdBy: 'user-1',
      unitOfMeasureId: UNIT_ID,
    });
    expect(dtoArg.quantity).toBeGreaterThan(0);

    // Інваріант 4: документ переведено у CONFIRMED через CAS-гейт (updateMany where status:DRAFT).
    expect(prisma.stockDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: DOC_ID, orgId: ORG, deletedAt: null, status: 'DRAFT' },
        data: expect.objectContaining({
          status: 'CONFIRMED',
          confirmedBy: 'user-1',
        }),
      }),
    );
  });

  it('transition(RECEIPT → CONFIRMED): MOVEMENT_TYPES[RECEIPT] resolved → не кидає "Непідтримуваний тип документу"', async () => {
    // Regression-guard: якщо хтось випадково забере 'RECEIPT' з MOVEMENT_TYPES — рядок 357
    // service кине `BadRequestException('Непідтримуваний тип документу: RECEIPT')`. Цей
    // тест ловить таку регресію, бо очікує success-path.
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      orgId: ORG,
      number: 'ПТ-2026-0001',
      type: StockDocumentType.RECEIPT,
      status: 'DRAFT',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: null,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 1,
          price: null,
          good: { unitId: null },
        },
      ],
    });
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      orgId: ORG,
      number: 'ПТ-2026-0001',
      type: StockDocumentType.RECEIPT,
      status: 'CONFIRMED',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: null,
      notes: null,
      documentDate: new Date(),
      confirmedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      branch: { name: 'Філія 1' },
      warehouse: { name: 'Склад 1' },
      targetWarehouse: null,
      lines: [],
    });

    await expect(service.transition(ORG, DOC_ID, 'CONFIRMED')).resolves.toBeDefined();
    expect(inventory.createMovement).toHaveBeenCalledOnce();
  });

  it('transition(RECEIPT → CONFIRMED) без рядків → BadRequestException; createMovement не викликаний', async () => {
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      orgId: ORG,
      number: 'ПТ-2026-0001',
      type: StockDocumentType.RECEIPT,
      status: 'DRAFT',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: null,
      lines: [],
    });

    await expect(service.transition(ORG, DOC_ID, 'CONFIRMED')).rejects.toThrow(BadRequestException);
    expect(inventory.createMovement).not.toHaveBeenCalled();
    expect(prisma.stockDocument.update).not.toHaveBeenCalled();
  });

  it('transition(): doc не знайдено → NotFoundException', async () => {
    prisma.stockDocument.findFirst.mockResolvedValueOnce(null);
    await expect(service.transition(ORG, DOC_ID, 'CONFIRMED')).rejects.toThrow(NotFoundException);
    expect(inventory.createMovement).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Asymmetry guard: RECEIPT vs TRANSFER (2 movements)
  // ──────────────────────────────────────────────────────────────────────

  it('transition(RECEIPT → CONFIRMED) — НЕ викликає createMovement з targetWarehouseId (на відміну від TRANSFER)', async () => {
    // Regression-guard: якщо хтось випадково додасть 'RECEIPT' до if (doc.type === 'TRANSFER')
    // гілки (наприклад через копі-паст), inventory.createMovement буде викликаний 2 рази —
    // один з doc.warehouseId, інший з doc.targetWarehouseId!. Останній впаде з 'Cannot read
    // properties of null', бо RECEIPT не має targetWarehouseId. Цей тест зловить таку зміну.
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      orgId: ORG,
      number: 'ПТ-2026-0001',
      type: StockDocumentType.RECEIPT,
      status: 'DRAFT',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: null, // ← RECEIPT не має target
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 3,
          price: null,
          good: { unitId: null },
        },
      ],
    });
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      orgId: ORG,
      number: 'ПТ-2026-0001',
      type: StockDocumentType.RECEIPT,
      status: 'CONFIRMED',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: null,
      notes: null,
      documentDate: new Date(),
      confirmedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      branch: { name: 'Філія 1' },
      warehouse: { name: 'Склад 1' },
      targetWarehouse: null,
      lines: [],
    });

    await service.transition(ORG, DOC_ID, 'CONFIRMED');

    // Single movement (RECEIPT does NOT split into writeoff+receipt).
    expect(inventory.createMovement).toHaveBeenCalledTimes(1);
    const [, dtoArg] = inventory.createMovement.mock.calls[0]!;
    // warehouseId = source (НЕ target).
    expect(dtoArg.warehouseId).toBe(WAREHOUSE_ID);
    // type стабільно RECEIPT (без TRANSFER-flip).
    expect(dtoArg.type).toBe(StockMovementType.RECEIPT);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Bug #490: defense-in-depth orgId guard on tx.stockDocumentLine.update
  // ──────────────────────────────────────────────────────────────────────

  // commit 852d5fa4 додав `where: { id: line.id, orgId }` у tx.stockDocumentLine.update
  // у transition() (рядок 335 service). Це defense-in-depth: line.id отримана з parent
  // doc що вже філтрований по orgId — безпечно "by construction", але compound where
  // зменшує blast-radius майбутнього refactor (наприклад, якщо хтось забере orgId з
  // parent fetch). Паралельно `purchase-orders.service.spec.ts:604` вже асертить
  // `where: { id: LINE_ID, orgId: ORG }` — узгоджуємо patten для stock-documents.
  it('Bug #490: transition(RECEIPT) персистить unitOfMeasureId через update з compound where { id, orgId }', async () => {
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      orgId: ORG,
      number: 'ПТ-2026-0001',
      type: StockDocumentType.RECEIPT,
      status: 'DRAFT',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: null,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 5,
          price: null,
          // good.unitId встановлений → персистенція unitOfMeasureId спрацьовує
          good: { unitId: UNIT_ID },
        },
      ],
    });
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      orgId: ORG,
      number: 'ПТ-2026-0001',
      type: StockDocumentType.RECEIPT,
      status: 'CONFIRMED',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: null,
      notes: null,
      documentDate: new Date(),
      confirmedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      branch: { name: 'Філія 1' },
      warehouse: { name: 'Склад 1' },
      targetWarehouse: null,
      lines: [],
    });

    await service.transition(ORG, DOC_ID, 'CONFIRMED');

    // КРИТИЧНИЙ assert: compound where включає orgId — defense-in-depth tenant guard.
    // Refactor що відкине orgId з where поверне tenant-safety до "by construction only"
    // → silent regression. Цей тест ловить таку зміну.
    expect(prisma.stockDocumentLine.update).toHaveBeenCalledWith({
      where: { id: LINE_ID, orgId: ORG },
      data: { unitOfMeasureId: UNIT_ID },
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Bug #610: TRANSFER cost-carry regression guard (commit 19f81ccb)
  //
  // TRANSFER — це WRITEOFF з source + RECEIPT в target. Раніше обидва йшли у Promise.all
  // і target RECEIPT отримував baseArgs.price (ціна документа, ЯКА У TRANSFER часто
  // salePrice або 0). Після 19f81ccb: SEQUENTIAL — src.weightedCostPrice (реальна FIFO
  // собівартість з партій джерела) передається у target RECEIPT.price → цільова партія
  // створюється з ПРАВИЛЬНОЮ собівартістю (не salePrice, не 0).
  //
  // Регресія без тесту: рефактор який поверне Promise.all — target отримає baseArgs.price
  // → cost carry зламаний, звіт рентабельності недостовірний. Verified live (spec header).
  // ──────────────────────────────────────────────────────────────────────
  it('Bug #610: TRANSFER передає src.weightedCostPrice у target RECEIPT.price (cost carry)', async () => {
    const TARGET_WH = '77777777-7777-4777-8777-777777777777';
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      orgId: ORG,
      number: 'ПМ-2026-0001',
      type: StockDocumentType.TRANSFER,
      status: 'DRAFT',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: TARGET_WH,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 5,
          price: 100, // baseArgs.price — fallback ЯКЩО weightedCostPrice=null
          good: { unitId: null },
        },
      ],
    });
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      orgId: ORG,
      number: 'ПМ-2026-0001',
      type: StockDocumentType.TRANSFER,
      status: 'CONFIRMED',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: TARGET_WH,
      notes: null,
      documentDate: new Date(),
      confirmedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      branch: { name: 'Філія 1' },
      warehouse: { name: 'Склад-1' },
      targetWarehouse: { name: 'Склад-2' },
      lines: [],
    });
    // WRITEOFF повертає weightedCostPrice=42 (реальна FIFO cost, ≠ baseArgs.price=100)
    inventory.createMovement
      .mockResolvedValueOnce({
        movementId: 'm-writeoff',
        consumed: [{ batchId: 'b-src', quantity: 5, costPrice: 42 }],
        weightedCostPrice: 42,
      })
      .mockResolvedValueOnce({
        movementId: 'm-receipt',
        consumed: [],
        weightedCostPrice: null,
      });

    await service.transition(ORG, DOC_ID, 'CONFIRMED', 'user-1');

    // Два виклики: WRITEOFF source потім RECEIPT target
    expect(inventory.createMovement).toHaveBeenCalledTimes(2);
    const [writeoffCall, receiptCall] = inventory.createMovement.mock.calls;
    // 1: WRITEOFF з source warehouseId, quantity=-5
    expect(writeoffCall![1]).toMatchObject({
      warehouseId: WAREHOUSE_ID,
      type: StockMovementType.WRITEOFF,
      quantity: -5,
    });
    // 2: RECEIPT з target warehouseId, quantity=+5, і КРИТИЧНО price=42 (FIFO cost)
    expect(receiptCall![1]).toMatchObject({
      warehouseId: TARGET_WH,
      type: StockMovementType.RECEIPT,
      quantity: 5,
      price: 42, // з src.weightedCostPrice — НЕ baseArgs.price=100
    });
  });

  it('Bug #610: TRANSFER коли src.weightedCostPrice=null → fallback до baseArgs.price', async () => {
    const TARGET_WH = '77777777-7777-4777-8777-777777777777';
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      orgId: ORG,
      number: 'ПМ-2026-0002',
      type: StockDocumentType.TRANSFER,
      status: 'DRAFT',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: TARGET_WH,
      lines: [{ id: LINE_ID, goodId: GOOD_ID, quantity: 3, price: 55, good: { unitId: null } }],
    });
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      orgId: ORG,
      number: 'ПМ-2026-0002',
      type: StockDocumentType.TRANSFER,
      status: 'CONFIRMED',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: TARGET_WH,
      notes: null,
      documentDate: new Date(),
      confirmedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      branch: { name: 'Філія 1' },
      warehouse: { name: 'Склад-1' },
      targetWarehouse: { name: 'Склад-2' },
      lines: [],
    });
    inventory.createMovement
      .mockResolvedValueOnce({
        movementId: 'm-writeoff',
        consumed: [],
        weightedCostPrice: null, // edge case: consume порожній (не має партій — не мало б статись, але defense-in-depth)
      })
      .mockResolvedValueOnce({
        movementId: 'm-receipt',
        consumed: [],
        weightedCostPrice: null,
      });

    await service.transition(ORG, DOC_ID, 'CONFIRMED', 'user-1');
    const [, receiptCall] = inventory.createMovement.mock.calls;
    expect(receiptCall![1]).toMatchObject({
      warehouseId: TARGET_WH,
      type: StockMovementType.RECEIPT,
      price: 55, // fallback до baseArgs.price
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // CONFIRM idempotency: CAS-гейт проти concurrent/retry подвійного руху складу
  //
  // FSM-check у transition() читає STALE pre-tx статус (findFirst ПОЗА $transaction).
  // Без in-tx CAS `updateMany where status:DRAFT` два concurrent CONFIRM (double-click,
  // retry після таймауту) обидва пройшли б FSM-check і кожен створив би повний набір
  // StockMovement → залишки ×2. CAS гарантує: лише перший запит row-locked переводить
  // DRAFT→CONFIRMED (count=1); другий бачить count=0 → throw → rollback усіх side-effects.
  // Дзеркалить supplier-payments.confirm (FIN-C1) + work-orders.transition (Хвиля 1).
  // ──────────────────────────────────────────────────────────────────────
  it('CONFIRM: CAS-гейт спрацьовує ПЕРЕД рухами складу (updateMany where status:DRAFT перший у tx)', async () => {
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      orgId: ORG,
      number: 'ПТ-2026-0009',
      type: StockDocumentType.RECEIPT,
      status: 'DRAFT',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: null,
      lines: [{ id: LINE_ID, goodId: GOOD_ID, quantity: 4, price: 100, good: { unitId: null } }],
    });
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      orgId: ORG,
      number: 'ПТ-2026-0009',
      type: StockDocumentType.RECEIPT,
      status: 'CONFIRMED',
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: null,
      notes: null,
      documentDate: new Date(),
      confirmedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      branch: { name: 'Філія 1' },
      warehouse: { name: 'Склад 1' },
      targetWarehouse: null,
      lines: [],
    });

    // Track invocation order: CAS updateMany МУСИТЬ передувати createMovement.
    const order: string[] = [];
    prisma.stockDocument.updateMany.mockImplementationOnce(() => {
      order.push('cas');
      return Promise.resolve({ count: 1 });
    });
    inventory.createMovement.mockImplementationOnce(() => {
      order.push('movement');
      return Promise.resolve({ movementId: 'm1', consumed: [], weightedCostPrice: null });
    });

    await service.transition(ORG, DOC_ID, 'CONFIRMED', 'user-1');

    expect(order[0]).toBe('cas');
    expect(order).toContain('movement');
    expect(prisma.stockDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: DOC_ID, orgId: ORG, deletedAt: null, status: 'DRAFT' },
        data: expect.objectContaining({ status: 'CONFIRMED' }),
      }),
    );
  });

  it('CONFIRM (concurrent/retry): CAS count=0 → BadRequestException, ЖОДНОГО руху складу', async () => {
    prisma.stockDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      orgId: ORG,
      number: 'ПТ-2026-0010',
      type: StockDocumentType.RECEIPT,
      status: 'DRAFT', // pre-tx snapshot стверджує DRAFT (stale)
      branchId: BRANCH_ID,
      warehouseId: WAREHOUSE_ID,
      targetWarehouseId: null,
      lines: [{ id: LINE_ID, goodId: GOOD_ID, quantity: 4, price: 100, good: { unitId: null } }],
    });
    // Інший concurrent запит уже забрав DRAFT → CAS цього запиту не знаходить рядок.
    prisma.stockDocument.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.transition(ORG, DOC_ID, 'CONFIRMED', 'user-1')).rejects.toThrow(
      BadRequestException,
    );
    // КРИТИЧНО: жодного руху складу — інакше залишки подвоїлися б.
    expect(inventory.createMovement).not.toHaveBeenCalled();
  });
});

/**
 * Phase D3 — «Пов'язані документи» складського документа (getLinkedDocuments/getLinkedCounts).
 * Дзеркалить Counterparty-патерн: orgId+deletedAt:null, Decimal→Number, zero-init counts.
 * Bug #641 lesson: count має рахувати те саме, що бачить detail (deletedAt:null скрізь).
 */
describe('StockDocumentsService — linked documents (Phase D3)', () => {
  let service: StockDocumentsService;
  let prisma: {
    stockDocument: { findFirst: any; findMany: any };
    purchaseOrder: { findFirst: any };
    warehouse: { findFirst: any };
  };

  const ORG = 'org-1';
  const DOC_ID = '11111111-1111-4111-8111-111111111111';
  const PO_ID = '22222222-2222-4222-8222-222222222222';
  const WAREHOUSE_ID = '33333333-3333-4333-8333-333333333333';
  const TARGET_WAREHOUSE_ID = '44444444-4444-4444-8444-444444444444';

  beforeEach(async () => {
    prisma = {
      stockDocument: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      purchaseOrder: { findFirst: vi.fn() },
      warehouse: { findFirst: vi.fn() },
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
      { id: DOC_ID, purchaseOrderId: PO_ID, targetWarehouseId: TARGET_WAREHOUSE_ID },
    ]);
    const res = await service.getLinkedCounts(ORG, [DOC_ID]);
    expect(res[DOC_ID]).toEqual({ purchaseOrder: 1, warehouses: 2 });
    expect(prisma.stockDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orgId: ORG, deletedAt: null }),
      }),
    );
  });
});

/**
 * Phase D2 — опціональний PO-джерело у create(). Персистенція + FK-guard.
 */
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
