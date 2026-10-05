/**
 * PurchaseOrdersService — transition — FSM-карта PO_TRANSITIONS
 *
 * Виділено з `purchase-orders.service.spec.ts` (був 1960 рядків, 7 незалежних
 * describe-блоків) 2026-10-05. Кейси перенесені ДОСЛІВНО, жоден it() не змінено:
 * сумарна кількість до і після розбиття — 55, перевірено раннером.
 *
 * Спільні DI-провайдери — `./purchase-orders.spec-fixture`.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PurchaseOrderStatus } from '@prisma/client';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PricingService } from '../inventory/pricing.service';
import { SettingsService } from '../settings/settings.service';
import { DeliveryTrackingService } from './delivery/delivery-tracking.service';
import { exchangeRatesProvider } from './purchase-orders.spec-fixture';

describe('PurchaseOrdersService.transition — FSM map', () => {
  let service: PurchaseOrdersService;
  let prisma: {
    purchaseOrder: {
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };

  const ORG = 'org-fsm';
  const PO_ID = '88888888-8888-4888-8888-888888888888';

  // findOne shape — викликається після transition для return
  const findOneResult = {
    id: PO_ID,
    orgId: ORG,
    number: 'PO-FSM',
    supplierId: 'supplier-x',
    warehouseId: 'warehouse-x',
    contractId: null,
    totalAmount: 0,
    notes: null,
    documentDate: new Date('2026-06-15'),
    createdAt: new Date(),
    updatedAt: new Date(),
    supplier: { firstName: 'S', lastName: '', companyName: null },
    warehouse: { name: 'W' },
    contract: null,
    lines: [],
  };

  beforeEach(async () => {
    prisma = {
      purchaseOrder: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        PurchaseOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: {} },
        { provide: SettlementsService, useValue: {} },
        { provide: DocumentNumberService, useValue: {} },
        { provide: PricingService, useValue: {} },
        // Bug #536: SettingsService потрібен для calcLineVat у create/update/receive paths.
        {
          provide: SettingsService,
          useValue: {
            getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }),
          },
        },
        {
          provide: DeliveryTrackingService,
          useValue: { enqueueInitial: vi.fn().mockResolvedValue(undefined) },
        },
        exchangeRatesProvider(),
      ],
    }).compile();
    service = module.get(PurchaseOrdersService);

    // service.transition() кличе findOne() в return — мокаємо обидва findFirst-и
    // у одному mock-runner-і шляхом resequenced returns.
  });

  // ── Allowed transitions ───────────────────────────────────────────────────

  it('Bug #481: DRAFT → ORDERED дозволено (PO_TRANSITIONS map)', async () => {
    // first findFirst — у tx.purchaseOrder.findFirst у transition(); second — findOne() return
    prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce({ status: PurchaseOrderStatus.DRAFT })
      .mockResolvedValueOnce(findOneResult);

    await service.transition(ORG, PO_ID, PurchaseOrderStatus.ORDERED);

    expect(prisma.purchaseOrder.update).toHaveBeenCalledWith({
      where: { id: PO_ID, orgId: ORG },
      data: { status: PurchaseOrderStatus.ORDERED },
    });
  });

  it('Bug #481: DRAFT → CANCELLED дозволено', async () => {
    prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce({ status: PurchaseOrderStatus.DRAFT })
      .mockResolvedValueOnce(findOneResult);

    await service.transition(ORG, PO_ID, PurchaseOrderStatus.CANCELLED);

    expect(prisma.purchaseOrder.update).toHaveBeenCalledWith({
      where: { id: PO_ID, orgId: ORG },
      data: { status: PurchaseOrderStatus.CANCELLED },
    });
  });

  it('Bug #481: ORDERED → PARTIAL дозволено', async () => {
    prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce({ status: PurchaseOrderStatus.ORDERED })
      .mockResolvedValueOnce(findOneResult);

    await service.transition(ORG, PO_ID, PurchaseOrderStatus.PARTIAL);

    expect(prisma.purchaseOrder.update).toHaveBeenCalledWith({
      where: { id: PO_ID, orgId: ORG },
      data: { status: PurchaseOrderStatus.PARTIAL },
    });
  });

  it('Bug #481: ORDERED → RECEIVED дозволено', async () => {
    prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce({ status: PurchaseOrderStatus.ORDERED })
      .mockResolvedValueOnce(findOneResult);

    await service.transition(ORG, PO_ID, PurchaseOrderStatus.RECEIVED);

    expect(prisma.purchaseOrder.update).toHaveBeenCalledWith({
      where: { id: PO_ID, orgId: ORG },
      data: { status: PurchaseOrderStatus.RECEIVED },
    });
  });

  it('Bug #481: PARTIAL → RECEIVED дозволено', async () => {
    prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce({ status: PurchaseOrderStatus.PARTIAL })
      .mockResolvedValueOnce(findOneResult);

    await service.transition(ORG, PO_ID, PurchaseOrderStatus.RECEIVED);

    expect(prisma.purchaseOrder.update).toHaveBeenCalledWith({
      where: { id: PO_ID, orgId: ORG },
      data: { status: PurchaseOrderStatus.RECEIVED },
    });
  });

  it('Bug #481: PARTIAL → CANCELLED дозволено', async () => {
    prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce({ status: PurchaseOrderStatus.PARTIAL })
      .mockResolvedValueOnce(findOneResult);

    await service.transition(ORG, PO_ID, PurchaseOrderStatus.CANCELLED);

    expect(prisma.purchaseOrder.update).toHaveBeenCalledWith({
      where: { id: PO_ID, orgId: ORG },
      data: { status: PurchaseOrderStatus.CANCELLED },
    });
  });

  // ── Forbidden transitions ─────────────────────────────────────────────────

  it('Bug #481: RECEIVED → DRAFT заборонено (термінальний статус)', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ status: PurchaseOrderStatus.RECEIVED });

    await expect(service.transition(ORG, PO_ID, PurchaseOrderStatus.DRAFT)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  it('Bug #481: CANCELLED → DRAFT заборонено (термінальний статус)', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ status: PurchaseOrderStatus.CANCELLED });

    await expect(service.transition(ORG, PO_ID, PurchaseOrderStatus.DRAFT)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  it('Bug #481: DRAFT → PARTIAL заборонено (FSM skip — потребує проходження ORDERED)', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ status: PurchaseOrderStatus.DRAFT });

    await expect(service.transition(ORG, PO_ID, PurchaseOrderStatus.PARTIAL)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  it('Bug #481: DRAFT → RECEIVED заборонено (FSM skip — потребує проходження ORDERED)', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ status: PurchaseOrderStatus.DRAFT });

    await expect(service.transition(ORG, PO_ID, PurchaseOrderStatus.RECEIVED)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  it('Bug #481: ORDERED → DRAFT заборонено (зворотний перехід)', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({ status: PurchaseOrderStatus.ORDERED });

    await expect(service.transition(ORG, PO_ID, PurchaseOrderStatus.DRAFT)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('Bug #481: PO не знайдено → NotFoundException + ніяких write', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(null);

    await expect(service.transition(ORG, PO_ID, PurchaseOrderStatus.ORDERED)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  it('Bug #481: tenant isolation — findFirst отримує orgId+deletedAt у where', async () => {
    prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce({ status: PurchaseOrderStatus.DRAFT })
      .mockResolvedValueOnce(findOneResult);

    await service.transition(ORG, PO_ID, PurchaseOrderStatus.ORDERED);

    // первый findFirst у tx.transition() — потрібно orgId, deletedAt: null, id
    expect(prisma.purchaseOrder.findFirst).toHaveBeenNthCalledWith(1, {
      where: { id: PO_ID, orgId: ORG, deletedAt: null },
      select: { status: true },
    });
  });

  it('Bug #481: $transaction обгортає весь FSM перехід з explicit timeout', async () => {
    prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce({ status: PurchaseOrderStatus.DRAFT })
      .mockResolvedValueOnce(findOneResult);

    await service.transition(ORG, PO_ID, PurchaseOrderStatus.ORDERED);

    // $transaction викликаний з callback + { timeout } options
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  // ─── Bug #541: regression-guard для PO_LINE_GOOD_INCLUDE drift ───────────────
  //
  // Refactor commit a50e1484 витяг shared `PO_LINE_GOOD_INCLUDE` const з 3 ідентичних
  // include shape-ів (findOne / create / update). toDto мапить кожне з полів через
  // `?? null`, тому видалення `internalCode: true` / `brand: { select: { name } }` з
  // const-shape залишає TS зеленим — frontend отримує null для існуючих DB-значень.
  // Цей тест ловить регресію: transition() кличе findOne() у return-path, тому ми
  // підставляємо `lines[0].good` з повним PART_GOOD_INCLUDE shape і асертимо що
  // `line.goodInternalCode / goodSku / goodBrandName` потрапляють у DTO.
  it('Bug #541: PO line DTO містить goodInternalCode / goodSku / goodBrandName', async () => {
    const fullLineFindOneResult = {
      ...findOneResult,
      lines: [
        {
          id: 'line-1',
          goodId: 'g-1',
          quantity: 2,
          price: 100,
          vatRate: 0,
          vatAmount: 0,
          receivedQty: 0,
          pricedSalePrice: null,
          pricingRuleName: null,
          unitOfMeasureId: null,
          good: {
            name: 'Filter',
            internalCode: 'INT-001',
            sku: 'SKU-1',
            unit: 'шт',
            unitOfMeasure: null,
            brand: { name: 'Toyota' },
          },
        },
      ],
    };
    prisma.purchaseOrder.findFirst
      .mockResolvedValueOnce({ status: PurchaseOrderStatus.DRAFT })
      .mockResolvedValueOnce(fullLineFindOneResult);

    const dto = await service.transition(ORG, PO_ID, PurchaseOrderStatus.ORDERED);

    expect(dto.lines).toHaveLength(1);
    expect(dto.lines[0]).toMatchObject({
      goodName: 'Filter',
      goodInternalCode: 'INT-001',
      goodSku: 'SKU-1',
      goodBrandName: 'Toyota',
    });
  });
});

// Bug #598: PurchaseOrdersService.findAll — sortBy=paymentDate має завжди повертати
// nulls-last у orderBy, інакше DESC-sort виносить сотні draft/no-pay-date PO наверх.
// Регресія-guard: наступний refactor що видалить `PO_NULLABLE_SORT_FIELDS`-argument
// з buildSortOrderBy виклику — падає.
