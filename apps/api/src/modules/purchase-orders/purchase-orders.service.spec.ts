import { Test } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { PurchaseOrderStatus } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PricingService } from '../inventory/pricing.service';

// Bug #187 / #200: regression-захист для applyPricing
// Bug #200: оновлено fixtures з полем `status` (defense-in-depth status guard c1dc5dd)
// Bug #200: pricingService мок переключено з `calculateSalePrice` на нові публічні
//           методи `getActiveRulesForOrg` + `computePriceFromRules` (рефактор c1dc5dd)
describe('PurchaseOrdersService.applyPricing', () => {
  let service: PurchaseOrdersService;
  let prisma: {
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn> };
    good: { updateMany: ReturnType<typeof vi.fn> };
    priceHistory: { createMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let pricingService: {
    getActiveRulesForOrg: ReturnType<typeof vi.fn>;
    computePriceFromRules: ReturnType<typeof vi.fn>;
  };

  const ORG = 'org-1';
  const PO_ID = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    prisma = {
      purchaseOrder: { findFirst: vi.fn() },
      good: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      priceHistory: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
    };
    pricingService = {
      getActiveRulesForOrg: vi.fn().mockResolvedValue([]),
      computePriceFromRules: vi.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        PurchaseOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: {} },
        { provide: SettlementsService, useValue: {} },
        { provide: DocumentNumberService, useValue: {} },
        { provide: PricingService, useValue: pricingService },
      ],
    }).compile();
    service = module.get(PurchaseOrdersService);
  });

  it('кидає NotFoundException коли PO не знайдено', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(null);
    await expect(service.applyPricing(ORG, PO_ID)).rejects.toThrow(NotFoundException);
    expect(prisma.good.updateMany).not.toHaveBeenCalled();
    expect(prisma.priceHistory.createMany).not.toHaveBeenCalled();
  });

  // Bug #200: status guard — DRAFT/ORDERED/CANCELLED не дозволені
  it('Bug #200 status guard: DRAFT → BadRequestException + не пише ні good ні priceHistory', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-DRAFT',
      status: PurchaseOrderStatus.DRAFT,
      lines: [],
    });
    await expect(service.applyPricing(ORG, PO_ID)).rejects.toThrow(BadRequestException);
    expect(pricingService.getActiveRulesForOrg).not.toHaveBeenCalled();
    expect(prisma.good.updateMany).not.toHaveBeenCalled();
    expect(prisma.priceHistory.createMany).not.toHaveBeenCalled();
  });

  // Bug #200: status guard — PARTIAL дозволений (друга гілка)
  it('Bug #200 status guard: PARTIAL → дозволено, applyPricing виконується', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-PARTIAL',
      status: PurchaseOrderStatus.PARTIAL,
      lines: [
        {
          goodId: 'good-1',
          price: 100,
          good: {
            name: 'Filter',
            salePrice: 130,
            category: null,
            goodType: 'SPARE_PART',
            brandId: null,
          },
        },
      ],
    });
    pricingService.computePriceFromRules.mockReturnValueOnce(150);

    const result = await service.applyPricing(ORG, PO_ID);
    expect(result.updated).toBe(1);
    expect(prisma.good.updateMany).toHaveBeenCalledTimes(1);
  });

  it('PO без lines → { updated: 0, details: [] } без жодного writeу', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-001',
      status: PurchaseOrderStatus.RECEIVED,
      lines: [],
    });
    const result = await service.applyPricing(ORG, PO_ID);
    expect(result).toEqual({ updated: 0, details: [] });
    expect(pricingService.computePriceFromRules).not.toHaveBeenCalled();
    expect(prisma.good.updateMany).not.toHaveBeenCalled();
    expect(prisma.priceHistory.createMany).not.toHaveBeenCalled();
  });

  it('ціна не змінилась (різниця < 0.001) → skip: не пише ні good.updateMany ні priceHistory', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-002',
      status: PurchaseOrderStatus.RECEIVED,
      lines: [
        {
          goodId: 'good-1',
          price: 100,
          good: {
            name: 'Filter',
            salePrice: 130,
            category: null,
            goodType: 'SPARE_PART',
            brandId: null,
          },
        },
      ],
    });
    // computePriceFromRules повертає те саме значення (130) → різниця = 0
    pricingService.computePriceFromRules.mockReturnValueOnce(130);

    const result = await service.applyPricing(ORG, PO_ID);

    expect(result.updated).toBe(0);
    expect(result.details).toHaveLength(0);
    expect(prisma.good.updateMany).not.toHaveBeenCalled();
    expect(prisma.priceHistory.createMany).not.toHaveBeenCalled();
  });

  it('ціна змінилась → виклик $transaction([good.updateMany, priceHistory.createMany])', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-003',
      status: PurchaseOrderStatus.RECEIVED,
      lines: [
        {
          goodId: 'good-2',
          price: 100,
          good: {
            name: 'Brake pad',
            salePrice: 130,
            category: 'BRAKES',
            goodType: 'SPARE_PART',
            brandId: 'brand-1',
          },
        },
      ],
    });
    pricingService.computePriceFromRules.mockReturnValueOnce(150);

    const result = await service.applyPricing(ORG, PO_ID);

    expect(result.updated).toBe(1);
    expect(result.details).toEqual([
      {
        goodId: 'good-2',
        goodName: 'Brake pad',
        costPrice: 100,
        oldSalePrice: 130,
        newSalePrice: 150,
      },
    ]);
    // Bug #191: updateMany з orgId — defense-in-depth
    expect(prisma.good.updateMany).toHaveBeenCalledWith({
      where: { id: 'good-2', orgId: ORG, deletedAt: null },
      data: { salePrice: 150 },
    });
    // Bug #194: priceHistory.createMany (chunked) — асертимо що один з елементів data містить очікуваний рядок
    expect(prisma.priceHistory.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          orgId: ORG,
          goodId: 'good-2',
          oldPrice: 130,
          newPrice: 150,
          costPrice: 100,
          reason: expect.stringContaining('PO-003'),
        }),
      ]),
    });
    // Bug #194: prefetch rules одним запитом
    expect(pricingService.getActiveRulesForOrg).toHaveBeenCalledTimes(1);
    expect(pricingService.getActiveRulesForOrg).toHaveBeenCalledWith(ORG);
  });

  it('mixed lines (одна змінилась, інша ні) → updated=1, тільки один write', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-004',
      status: PurchaseOrderStatus.RECEIVED,
      lines: [
        {
          goodId: 'g-a',
          price: 100,
          good: { name: 'A', salePrice: 150, category: null, goodType: null, brandId: null },
        },
        {
          goodId: 'g-b',
          price: 50,
          good: { name: 'B', salePrice: 70, category: null, goodType: null, brandId: null },
        },
      ],
    });
    pricingService.computePriceFromRules
      .mockReturnValueOnce(150) // no change for A
      .mockReturnValueOnce(80); // change for B

    const result = await service.applyPricing(ORG, PO_ID);
    expect(result.updated).toBe(1);
    expect(result.details).toEqual([
      {
        goodId: 'g-b',
        goodName: 'B',
        costPrice: 50,
        oldSalePrice: 70,
        newSalePrice: 80,
      },
    ]);
    expect(prisma.good.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.good.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'g-b' }) }),
    );
  });

  it('пропускає line.good=null (soft-deleted Good) без TypeError', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-005',
      status: PurchaseOrderStatus.RECEIVED,
      lines: [{ goodId: 'orphan', price: 100, good: null }],
    });
    const result = await service.applyPricing(ORG, PO_ID);
    expect(result.updated).toBe(0);
    expect(pricingService.computePriceFromRules).not.toHaveBeenCalled();
    expect(prisma.good.updateMany).not.toHaveBeenCalled();
  });
});

// Bug #239: regression-захист для UoM override tenant validation у receive().
// Покриває: (a) fallback на good.unitId коли override відсутній; (b) explicit own-org override;
// (c) cross-tenant UoM ID → BadRequestException + жоден inventory write; (d) fallback коли good.unitId=null.
// Bug #237: conditional update line.unitOfMeasureId — лише на першому receive або з explicit override.
describe('PurchaseOrdersService.receive — UoM override tenant validation (Bug #239)', () => {
  let service: PurchaseOrdersService;
  let prisma: {
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    purchaseOrderLine: { update: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    unitOfMeasure: { findMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let inventory: { createMovement: ReturnType<typeof vi.fn> };
  let settlements: { createTransaction: ReturnType<typeof vi.fn> };

  const ORG = 'org-A';
  const PO_ID = '11111111-1111-4111-8111-111111111111';
  const LINE_ID = '22222222-2222-4222-8222-222222222222';
  const GOOD_ID = '33333333-3333-4333-8333-333333333333';
  const SUPPLIER_ID = '44444444-4444-4444-8444-444444444444';
  const WAREHOUSE_ID = '55555555-5555-4555-8555-555555555555';
  const USER_ID = '66666666-6666-4666-8666-666666666666';
  const GOOD_UNIT_ID = '77777777-7777-4777-8777-777777777777'; // own-org default UoM
  const OWN_UOM_ID = '88888888-8888-4888-8888-888888888888'; // own-org override UoM
  const CROSS_UOM_ID = '99999999-9999-4999-8999-999999999999'; // foreign-org UoM

  beforeEach(async () => {
    prisma = {
      purchaseOrder: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      purchaseOrderLine: {
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn(),
      },
      unitOfMeasure: { findMany: vi.fn() },
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
    };
    inventory = { createMovement: vi.fn().mockResolvedValue(undefined) };
    settlements = { createTransaction: vi.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        PurchaseOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: inventory },
        { provide: SettlementsService, useValue: settlements },
        { provide: DocumentNumberService, useValue: {} },
        { provide: PricingService, useValue: {} },
      ],
    }).compile();
    service = module.get(PurchaseOrdersService);

    // Default PO fixture: ORDERED status, one line, RECEIVED qty = 0
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.ORDERED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 0,
          good: { unitId: GOOD_UNIT_ID },
        },
      ],
    });
    // After increment all received → triggers RECEIVED status branch
    prisma.purchaseOrderLine.findMany.mockResolvedValue([
      { id: LINE_ID, quantity: 10, receivedQty: 10 },
    ]);
    // findOne after receive — return same PO (service calls this.findOne at end)
    // Will be matched by 2nd findFirst call
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.ORDERED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      totalAmount: 1000,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 0,
          good: { unitId: GOOD_UNIT_ID },
        },
      ],
    });
  });

  it('receive без unitOfMeasureId override → fallback на good.unitId, createMovement отримує good.unitId', async () => {
    // Final findOne after receive (для return value) — service викликає findOne(orgId, id) внутрішньо
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.RECEIVED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      totalAmount: 1000,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 10,
          good: { name: 'X', sku: null, unit: 'шт', unitOfMeasure: null },
          unitOfMeasureId: GOOD_UNIT_ID,
        },
      ],
      supplier: { firstName: 'S', lastName: '', companyName: null },
      warehouse: { name: 'W' },
    });

    await service.receive(ORG, PO_ID, { lines: [{ lineId: LINE_ID, receivedQty: 10 }] }, USER_ID);

    // unitOfMeasure.findMany НЕ викликаний (overrideUomIds порожній)
    expect(prisma.unitOfMeasure.findMany).not.toHaveBeenCalled();
    // inventory.createMovement отримав unitOfMeasureId з good.unitId
    expect(inventory.createMovement).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ unitOfMeasureId: GOOD_UNIT_ID, goodId: GOOD_ID }),
      expect.anything(),
    );
  });

  it('receive з own-org unitOfMeasureId override → unitOfMeasure.findMany викликано з orgId, override застосовано', async () => {
    prisma.unitOfMeasure.findMany.mockResolvedValueOnce([{ id: OWN_UOM_ID }]);
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.RECEIVED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      totalAmount: 1000,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 10,
          good: { name: 'X', sku: null, unit: 'шт', unitOfMeasure: null },
          unitOfMeasureId: OWN_UOM_ID,
        },
      ],
      supplier: { firstName: 'S', lastName: '', companyName: null },
      warehouse: { name: 'W' },
    });

    await service.receive(
      ORG,
      PO_ID,
      { lines: [{ lineId: LINE_ID, receivedQty: 10, unitOfMeasureId: OWN_UOM_ID }] },
      USER_ID,
    );

    // Tenant validation викликана з orgId і id ∈ overrideUomIds
    expect(prisma.unitOfMeasure.findMany).toHaveBeenCalledWith({
      where: { orgId: ORG, id: { in: [OWN_UOM_ID] }, deletedAt: null },
      select: { id: true },
      take: 1000,
    });
    // resolvedUomId = override (не good.unitId)
    expect(inventory.createMovement).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ unitOfMeasureId: OWN_UOM_ID }),
      expect.anything(),
    );
  });

  it('receive з cross-tenant unitOfMeasureId → BadRequestException, inventory write НЕ викликаний (Bug #186)', async () => {
    // findMany повертає порожній масив — UoM не знайдено в org
    prisma.unitOfMeasure.findMany.mockResolvedValueOnce([]);

    await expect(
      service.receive(
        ORG,
        PO_ID,
        { lines: [{ lineId: LINE_ID, receivedQty: 10, unitOfMeasureId: CROSS_UOM_ID }] },
        USER_ID,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.unitOfMeasure.findMany).toHaveBeenCalledWith({
      where: { orgId: ORG, id: { in: [CROSS_UOM_ID] }, deletedAt: null },
      select: { id: true },
      take: 1000,
    });
    // Жоден write — захист от cross-tenant linkage
    expect(inventory.createMovement).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
    expect(prisma.purchaseOrderLine.update).not.toHaveBeenCalled();
  });

  it('receive — кілька рядків з різними override-UoM: всі валідуються одним findMany (батч)', async () => {
    const LINE_ID_2 = '22222222-2222-4222-8222-222222222223';
    const OWN_UOM_ID_2 = '88888888-8888-4888-8888-888888888889';

    prisma.unitOfMeasure.findMany.mockResolvedValueOnce([{ id: OWN_UOM_ID }, { id: OWN_UOM_ID_2 }]);
    prisma.purchaseOrder.findFirst.mockReset();
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.ORDERED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 5,
          price: 100,
          receivedQty: 0,
          good: { unitId: GOOD_UNIT_ID },
        },
        {
          id: LINE_ID_2,
          goodId: GOOD_ID,
          quantity: 5,
          price: 100,
          receivedQty: 0,
          good: { unitId: GOOD_UNIT_ID },
        },
      ],
    });
    prisma.purchaseOrderLine.findMany.mockResolvedValueOnce([
      { id: LINE_ID, quantity: 5, receivedQty: 5 },
      { id: LINE_ID_2, quantity: 5, receivedQty: 5 },
    ]);
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.RECEIVED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      totalAmount: 1000,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 5,
          price: 100,
          receivedQty: 5,
          good: { name: 'X', sku: null, unit: 'шт', unitOfMeasure: null },
          unitOfMeasureId: OWN_UOM_ID,
        },
      ],
      supplier: { firstName: 'S', lastName: '', companyName: null },
      warehouse: { name: 'W' },
    });

    await service.receive(
      ORG,
      PO_ID,
      {
        lines: [
          { lineId: LINE_ID, receivedQty: 5, unitOfMeasureId: OWN_UOM_ID },
          { lineId: LINE_ID_2, receivedQty: 5, unitOfMeasureId: OWN_UOM_ID_2 },
        ],
      },
      USER_ID,
    );

    // Один батчевий findMany з in:[a,b], не два окремих запита
    expect(prisma.unitOfMeasure.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.unitOfMeasure.findMany).toHaveBeenCalledWith({
      where: {
        orgId: ORG,
        id: expect.objectContaining({ in: expect.arrayContaining([OWN_UOM_ID, OWN_UOM_ID_2]) }),
        deletedAt: null,
      },
      select: { id: true },
      take: 1000,
    });
  });

  // Bug #237: partial receive не перезаписує line UoM коли override відсутній
  it('Bug #237: partial receive без override → line.unitOfMeasureId НЕ оновлюється (receivedQty > 0)', async () => {
    prisma.purchaseOrder.findFirst.mockReset();
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.PARTIAL,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 3, // already partially received
          good: { unitId: GOOD_UNIT_ID },
        },
      ],
    });
    prisma.purchaseOrderLine.findMany.mockResolvedValueOnce([
      { id: LINE_ID, quantity: 10, receivedQty: 10 },
    ]);
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.RECEIVED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      totalAmount: 1000,
      lines: [],
      supplier: { firstName: 'S', lastName: '', companyName: null },
      warehouse: { name: 'W' },
    });

    await service.receive(ORG, PO_ID, { lines: [{ lineId: LINE_ID, receivedQty: 7 }] }, USER_ID);

    // line.update called — БЕЗ unitOfMeasureId в data (тільки receivedQty increment)
    expect(prisma.purchaseOrderLine.update).toHaveBeenCalledWith({
      where: { id: LINE_ID, orgId: ORG },
      data: { receivedQty: { increment: 7 } },
    });
  });

  it('Bug #237: partial receive з explicit override → line.unitOfMeasureId оновлюється (intent)', async () => {
    prisma.unitOfMeasure.findMany.mockResolvedValueOnce([{ id: OWN_UOM_ID }]);
    prisma.purchaseOrder.findFirst.mockReset();
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.PARTIAL,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      lines: [
        {
          id: LINE_ID,
          goodId: GOOD_ID,
          quantity: 10,
          price: 100,
          receivedQty: 3,
          good: { unitId: GOOD_UNIT_ID },
        },
      ],
    });
    prisma.purchaseOrderLine.findMany.mockResolvedValueOnce([
      { id: LINE_ID, quantity: 10, receivedQty: 10 },
    ]);
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.RECEIVED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      totalAmount: 1000,
      lines: [],
      supplier: { firstName: 'S', lastName: '', companyName: null },
      warehouse: { name: 'W' },
    });

    await service.receive(
      ORG,
      PO_ID,
      { lines: [{ lineId: LINE_ID, receivedQty: 7, unitOfMeasureId: OWN_UOM_ID }] },
      USER_ID,
    );

    // explicit override → unitOfMeasureId присутній у data
    expect(prisma.purchaseOrderLine.update).toHaveBeenCalledWith({
      where: { id: LINE_ID, orgId: ORG },
      data: { receivedQty: { increment: 7 }, unitOfMeasureId: OWN_UOM_ID },
    });
  });
});
