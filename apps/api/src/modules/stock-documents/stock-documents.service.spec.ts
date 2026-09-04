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
