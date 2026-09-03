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
import { SettingsService } from '../settings/settings.service';
import { kyivToday, addDaysKyiv } from '../../common/utils/kyiv-date';

// Bug #187 / #200: regression-захист для applyPricing
// Bug #200: оновлено fixtures з полем `status` (defense-in-depth status guard c1dc5dd)
// Bug #200: pricingService мок переключено з `calculateSalePrice` на нові публічні
//           методи `getActiveRulesForOrg` + `computePriceFromRules` (рефактор c1dc5dd)
describe('PurchaseOrdersService.applyPricing', () => {
  let service: PurchaseOrdersService;
  let prisma: {
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    purchaseOrderLine: { update: ReturnType<typeof vi.fn> };
    good: { updateMany: ReturnType<typeof vi.fn> };
    priceHistory: { createMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let pricingService: {
    getActiveRulesForOrg: ReturnType<typeof vi.fn>;
    computePriceFromRules: ReturnType<typeof vi.fn>;
    resolveRule: ReturnType<typeof vi.fn>;
  };

  const ORG = 'org-1';
  const PO_ID = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    prisma = {
      purchaseOrder: {
        findFirst: vi.fn(),
        // Bug #536: applyPricing updates pricedAt; refactor commit 90101494 (feat(po): pricedAt).
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      // Bug #536: applyPricing now writes pricedSalePrice + pricingRuleName per-line
      // (commit 5127e64b). Mock needed so $transaction callback doesn't crash.
      purchaseOrderLine: { update: vi.fn().mockResolvedValue({}) },
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
      // Bug #536: рефактор перенесений на resolveRule (повертає {price, ruleName}).
      // Тести нижче по дефолту чекають "no rule matched" — fallback {price: oldSalePrice, ruleName: null}.
      resolveRule: vi
        .fn()
        .mockImplementation(
          (
            _rules: unknown,
            _goodId: string,
            _category: unknown,
            _goodType: unknown,
            _brandId: unknown,
            _cost: number,
            _supplierId: unknown,
          ) => ({ price: _cost, ruleName: null }),
        ),
    };

    const module = await Test.createTestingModule({
      providers: [
        PurchaseOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: {} },
        { provide: SettlementsService, useValue: {} },
        { provide: DocumentNumberService, useValue: {} },
        { provide: PricingService, useValue: pricingService },
        // Bug #536: SettingsService додано у constructor commit 60b25347 (feat(vat)),
        // тест-модуль не оновлено → 38/38 fail на compile. Mock повертає NONE/0 щоб
        // calcLineVat у create/update path працював без втручання у applyPricing-тести.
        {
          provide: SettingsService,
          useValue: {
            getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }),
          },
        },
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
    pricingService.resolveRule.mockReturnValueOnce({ price: 150, ruleName: 'rule-A' });

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
    expect(pricingService.resolveRule).not.toHaveBeenCalled();
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
    // resolveRule повертає те саме значення (130) → різниця = 0 → skip update.
    // ruleName='rule-X' → rule matched, тому updated=1 (нова семантика: counts ruleName !== null),
    // але good.updateMany не викликається бо dedupedPlan фільтрує lines з |diff| < 0.001.
    pricingService.resolveRule.mockReturnValueOnce({ price: 130, ruleName: 'rule-X' });

    const result = await service.applyPricing(ORG, PO_ID);

    expect(result.updated).toBe(1); // rule matched
    expect(result.details).toHaveLength(1); // plan завжди містить line
    expect(prisma.good.updateMany).not.toHaveBeenCalled(); // price diff < 0.001 → skip
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
    pricingService.resolveRule.mockReturnValueOnce({ price: 150, ruleName: 'rule-A' });

    const result = await service.applyPricing(ORG, PO_ID);

    expect(result.updated).toBe(1);
    expect(result.details).toEqual([
      expect.objectContaining({
        goodId: 'good-2',
        goodName: 'Brake pad',
        costPrice: 100,
        oldSalePrice: 130,
        newSalePrice: 150,
      }),
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
    pricingService.resolveRule
      .mockReturnValueOnce({ price: 150, ruleName: null }) // no change for A
      .mockReturnValueOnce({ price: 80, ruleName: 'rule-B' }); // change for B

    const result = await service.applyPricing(ORG, PO_ID);
    // mixed: A→ruleName=null no change, B→ruleName='rule-B' change → updated counts ruleName !== null.
    expect(result.updated).toBe(1);
    // Both lines у plan; dedupedPlan filter-ить за newSalePrice ≠ oldSalePrice → лише B пише good.updateMany.
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
    expect(pricingService.resolveRule).not.toHaveBeenCalled();
    expect(prisma.good.updateMany).not.toHaveBeenCalled();
  });

  // Bug #489: regression-guard для deduplicateBy(plan, u => u.goodId).
  // PO може мати кілька рядків з ОДНИМ goodId (різні lots з різною ціною/UoM на той самий товар).
  // Sequential for-loop мав last-write-wins. Promise.all без dedup → race → нондетерміністичний
  // salePrice у БД. dedupedPlan робить last-wins ДО Promise.all. Цей тест ловить refactor що
  // дропне deduplicateBy(): без нього updateMany викликався б ДВІЧІ для одного PK.
  it('Bug #489: дублікати по goodId у lines → updateMany викликається ОДИН раз (last-wins у БД)', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-DUP',
      status: PurchaseOrderStatus.RECEIVED,
      lines: [
        {
          goodId: 'good-dup',
          price: 100, // перший lot
          good: {
            name: 'Multi-lot',
            salePrice: 110,
            category: null,
            goodType: 'SPARE_PART',
            brandId: null,
          },
        },
        {
          goodId: 'good-dup',
          price: 200, // другий lot — last-wins
          good: {
            name: 'Multi-lot',
            salePrice: 110,
            category: null,
            goodType: 'SPARE_PART',
            brandId: null,
          },
        },
      ],
    });
    // resolveRule викликається для кожного line (двічі) — різні cost-prices
    pricingService.resolveRule
      .mockReturnValueOnce({ price: 150, ruleName: 'lot-A' }) // для першого lot (cost=100)
      .mockReturnValueOnce({ price: 250, ruleName: 'lot-B' }); // для другого lot (cost=200) — last-wins у БД

    const result = await service.applyPricing(ORG, PO_ID);

    // result.updated = 2 (плановий plan.length — інформаційно для UI "оброблено 2 рядки PO")
    expect(result.updated).toBe(2);
    expect(result.details).toHaveLength(2);
    // КРИТИЧНИЙ assert: updateMany викликається РІВНО РАЗ для дубльованого goodId
    // (без deduplicateBy → 2 writes на той самий PK → Promise.all race → nondeterminism).
    expect(prisma.good.updateMany).toHaveBeenCalledTimes(1);
    // last-wins: остання обчислена ціна (250) перемагає у БД (Map.set другий раз перезаписує)
    expect(prisma.good.updateMany).toHaveBeenCalledWith({
      where: { id: 'good-dup', orgId: ORG, deletedAt: null },
      data: { salePrice: 250 },
    });
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
        // Bug #536: SettingsService потрібен для calcLineVat у create/update/receive paths.
        {
          provide: SettingsService,
          useValue: {
            getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }),
          },
        },
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
    // receive пише SUPPLIER_CHARGE (−1: ми винні постачальнику), НЕ CHARGE (+1, клієнтський).
    // Fix знаку балансу постачальника — без цього графік оплат не бачить проведених PO.
    expect(settlements.createTransaction).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        counterpartyId: SUPPLIER_ID,
        type: 'SUPPLIER_CHARGE',
        amount: 1000,
        documentType: 'PurchaseOrder',
      }),
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

  it('Bug #483 (review): duplicate lineId у dto.lines → BadRequestException (без подвійного increment)', async () => {
    // Без dedup-guard Promise.all виконав би два update.increment для того самого lineId,
    // що подвоїло б receivedQty. Service кидає ще ДО $transaction.
    await expect(
      service.receive(
        ORG,
        PO_ID,
        {
          lines: [
            { lineId: LINE_ID, receivedQty: 5 },
            { lineId: LINE_ID, receivedQty: 3 }, // duplicate!
          ],
        },
        USER_ID,
      ),
    ).rejects.toThrow('Кожен рядок прийому має бути унікальним');
    // Захист спрацьовує перед $transaction → жодного запису у БД.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.purchaseOrderLine.update).not.toHaveBeenCalled();
    expect(inventory.createMovement).not.toHaveBeenCalled();
  });

  it('receive повне → авто paymentDate = сьогодні + contract.paymentDeferDays (RECEIVED)', async () => {
    // PO з договором (10 днів відтермінування), без paymentDate.
    prisma.purchaseOrder.findFirst.mockReset();
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.ORDERED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      paymentDate: null,
      contract: { paymentDeferDays: 10 },
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
    // findOne у кінці
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

    // Останній purchaseOrder.update у $transaction — зі статусом RECEIVED + paymentDate.
    const updateCalls = prisma.purchaseOrder.update.mock.calls;
    const statusUpdate = updateCalls.find(
      c => (c[0] as { data?: { status?: string } }).data?.status === PurchaseOrderStatus.RECEIVED,
    );
    expect(statusUpdate).toBeDefined();
    const data = (statusUpdate![0] as { data: { paymentDate?: Date } }).data;
    expect(data.paymentDate).toBeInstanceOf(Date);
    // = сьогодні (Kyiv) + 10 днів. Bug #592: попередня версія тесту рахувала expected
    // через `new Date() + setUTCDate` — це UTC-арифметика, а impl використовує Kyiv (kyivToday()).
    // На кордоні днів (Kyiv +2/+3 vs UTC) різниця в 1 день → тест падає в ~3 годинних вікнах.
    // Правильно: використовувати ті самі kyivToday/addDaysKyiv що і imp (DST-aware).
    const expected = addDaysKyiv(kyivToday(), 10);
    expect(data.paymentDate!.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
  });

  it('receive без договору → paymentDate НЕ встановлюється', async () => {
    prisma.purchaseOrder.findFirst.mockReset();
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      orgId: ORG,
      number: 'PO-RX',
      status: PurchaseOrderStatus.ORDERED,
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      paymentDate: null,
      contract: null,
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

    const statusUpdate = prisma.purchaseOrder.update.mock.calls.find(
      c => (c[0] as { data?: { status?: string } }).data?.status === PurchaseOrderStatus.RECEIVED,
    );
    expect(statusUpdate).toBeDefined();
    expect((statusUpdate![0] as { data: Record<string, unknown> }).data).not.toHaveProperty(
      'paymentDate',
    );
  });
});

// Bug #473-#476: regression guards для update() — contract resolution + tenant guards
// (commits 115fea9e + 32c6115f: editable supplier/warehouse/contract у DRAFT, auto-clear
// stale contract при зміні постачальника).
describe('PurchaseOrdersService.update — contract resolution', () => {
  let service: PurchaseOrdersService;
  let prisma: {
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    purchaseOrderLine: {
      updateMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
    };
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    warehouse: { findFirst: ReturnType<typeof vi.fn> };
    counterpartyContract: { findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };

  const ORG = 'org-A';
  const PO_ID = '11111111-1111-4111-8111-111111111111';
  const OLD_SUPPLIER = '22222222-2222-4222-8222-222222222222';
  const NEW_SUPPLIER = '33333333-3333-4333-8333-333333333333';
  const WAREHOUSE = '44444444-4444-4444-8444-444444444444';
  const NEW_WAREHOUSE = '55555555-5555-4555-8555-555555555555';
  const OLD_CONTRACT = '66666666-6666-4666-8666-666666666666';
  const NEW_CONTRACT = '77777777-7777-4777-8777-777777777777';

  // toDto-shaped result for tx.purchaseOrder.update().include
  const updateResult = {
    id: PO_ID,
    orgId: ORG,
    number: 'PO-RX',
    status: PurchaseOrderStatus.DRAFT,
    supplierId: NEW_SUPPLIER,
    warehouseId: WAREHOUSE,
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
        update: vi.fn().mockResolvedValue(updateResult),
      },
      purchaseOrderLine: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      counterparty: { findFirst: vi.fn() },
      warehouse: { findFirst: vi.fn() },
      counterpartyContract: { findFirst: vi.fn() },
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
      ],
    }).compile();
    service = module.get(PurchaseOrdersService);
  });

  const draftPo = (overrides: Partial<{ supplierId: string; contractId: string | null }> = {}) => ({
    status: PurchaseOrderStatus.DRAFT,
    totalAmount: 0,
    supplierId: overrides.supplierId ?? OLD_SUPPLIER,
    // Use `in` check замість `??` — `null` is a valid override value (po має null contractId)
    contractId: 'contractId' in overrides ? overrides.contractId! : OLD_CONTRACT,
  });

  // Bug #473 — критичний regression-guard для commit 32c6115f.
  // Branch 3: supplierChanged && po.contractId → newContractId = null (auto-clear stale).
  it('Bug #473: supplier changed without contractId у dto → auto-clear stale contract', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(draftPo());
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: NEW_SUPPLIER });

    await service.update(ORG, PO_ID, { supplierId: NEW_SUPPLIER });

    expect(prisma.counterpartyContract.findFirst).not.toHaveBeenCalled();
    expect(prisma.purchaseOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PO_ID, orgId: ORG },
        data: expect.objectContaining({
          supplierId: NEW_SUPPLIER,
          contractId: null,
        }),
      }),
    );
  });

  // Bug #473 — guard має НЕ спрацювати коли po.contractId уже null
  it('Bug #473: supplier changed коли po.contractId уже null → contractId не явно clear (undefined)', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(draftPo({ contractId: null }));
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: NEW_SUPPLIER });

    await service.update(ORG, PO_ID, { supplierId: NEW_SUPPLIER });

    // Якщо po.contractId уже null → не треба auto-clear: Branch 3 не спрацьовує.
    // newContractId залишається undefined → Prisma trivially no-op.
    const updateCall = prisma.purchaseOrder.update.mock.calls[0][0];
    expect(updateCall.data.supplierId).toBe(NEW_SUPPLIER);
    expect(updateCall.data.contractId).toBeUndefined();
  });

  // Bug #474 — explicit clear (contractId=null від frontend після ручного зняття договору)
  it('Bug #474: explicit contractId=null → newContractId=null persisted без validation запиту', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(draftPo());

    await service.update(ORG, PO_ID, { contractId: null });

    // Не робить validation запиту — null обходить findFirst для contract
    expect(prisma.counterpartyContract.findFirst).not.toHaveBeenCalled();
    expect(prisma.purchaseOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contractId: null,
        }),
      }),
    );
  });

  // Bug #475 — cross-org supplierId rejection
  it('Bug #475: cross-org supplierId → NotFoundException, жоден write', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(draftPo());
    // findFirst returns null → supplier у іншій org
    prisma.counterparty.findFirst.mockResolvedValueOnce(null);

    await expect(service.update(ORG, PO_ID, { supplierId: NEW_SUPPLIER })).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.counterparty.findFirst).toHaveBeenCalledWith({
      where: { id: NEW_SUPPLIER, orgId: ORG, deletedAt: null },
      select: { id: true },
    });
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  // Bug #475 — cross-org warehouseId rejection
  it('Bug #475: cross-org warehouseId → NotFoundException, жоден write', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(draftPo());
    prisma.warehouse.findFirst.mockResolvedValueOnce(null);

    await expect(service.update(ORG, PO_ID, { warehouseId: NEW_WAREHOUSE })).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.warehouse.findFirst).toHaveBeenCalledWith({
      where: { id: NEW_WAREHOUSE, orgId: ORG, deletedAt: null },
      select: { id: true },
    });
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  // Bug #476 — cross-supplier contractId rejection (Branch 1 валідує counterpartyId=effective)
  it('Bug #476: contractId з іншого постачальника → NotFoundException, жоден write', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(draftPo());
    // supplier valid
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: NEW_SUPPLIER });
    // contract findFirst returns null (contract belongs to інший supplier)
    prisma.counterpartyContract.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.update(ORG, PO_ID, {
        supplierId: NEW_SUPPLIER,
        contractId: NEW_CONTRACT,
      }),
    ).rejects.toThrow(NotFoundException);

    // ОБОВ'ЯЗКОВО валідує counterpartyId = effectiveSupplierId
    expect(prisma.counterpartyContract.findFirst).toHaveBeenCalledWith({
      where: {
        id: NEW_CONTRACT,
        orgId: ORG,
        counterpartyId: NEW_SUPPLIER, // effectiveSupplierId = dto.supplierId
        contractType: 'PURCHASE',
        deletedAt: null,
      },
      select: { id: true },
    });
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  // Bug #476 supplementary — valid contractId передано → встановлюється
  it('Bug #476: valid contractId передано → встановлюється, validate проти effective supplier', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce(draftPo());
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: NEW_SUPPLIER });
    prisma.counterpartyContract.findFirst.mockResolvedValueOnce({ id: NEW_CONTRACT });

    await service.update(ORG, PO_ID, {
      supplierId: NEW_SUPPLIER,
      contractId: NEW_CONTRACT,
    });

    expect(prisma.purchaseOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          supplierId: NEW_SUPPLIER,
          contractId: NEW_CONTRACT,
        }),
      }),
    );
  });

  // Defense — guard not on DRAFT
  it('non-DRAFT PO → BadRequestException, жоден write', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      ...draftPo(),
      status: PurchaseOrderStatus.ORDERED,
    });

    await expect(service.update(ORG, PO_ID, { notes: 'x' })).rejects.toThrow(BadRequestException);
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });
});

// Bug #481: regression guards для transition() — FSM map PO_TRANSITIONS + assertFsmTransition.
// Commit 115fea9e (feat(purchase-orders): show all fields, editable supplier/warehouse/contract
// in DRAFT, FSM arrows always visible) виставив "FSM arrows always visible" у фронті — без
// будь-яких backend unit-тестів на FSM-перехід. Видалення PO_TRANSITIONS[STATE] = [...]
// або заміна assertFsmTransition на голий tx.update({ status }) пройде CI зеленим,
// runtime отримає silently corrupted FSM (можна перевести RECEIVED→DRAFT без error).
// Без цих guards: майбутній refactor FSM-map або "FSM arrows always visible" feature
// (commit 115fea9e) може посилати недозволений status зі фронту → бекенд silently апдейтить
// → broken invariant.
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
describe('PurchaseOrdersService.findAll — sortBy=paymentDate nulls-last (Bug #598)', () => {
  let service: PurchaseOrdersService;
  let prisma: {
    purchaseOrder: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
    supplierPayment: { groupBy: ReturnType<typeof vi.fn> };
  };

  const ORG = 'org-1';

  beforeEach(async () => {
    prisma = {
      purchaseOrder: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      supplierPayment: { groupBy: vi.fn().mockResolvedValue([]) },
    };
    const module = await Test.createTestingModule({
      providers: [
        PurchaseOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: {} },
        { provide: SettlementsService, useValue: {} },
        { provide: DocumentNumberService, useValue: {} },
        { provide: PricingService, useValue: {} },
        {
          provide: SettingsService,
          useValue: {
            getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }),
          },
        },
      ],
    }).compile();
    service = module.get(PurchaseOrdersService);
  });

  function findManyOrderBy() {
    return (
      prisma.purchaseOrder.findMany.mock.calls[0]![0] as {
        orderBy: Record<string, unknown>;
      }
    ).orderBy;
  }

  it('sortBy=paymentDate + desc → { paymentDate: { sort: desc, nulls: last } }', async () => {
    await service.findAll(
      ORG,
      1,
      20,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      'paymentDate',
      'desc',
    );
    expect(findManyOrderBy()).toEqual({ paymentDate: { sort: 'desc', nulls: 'last' } });
  });

  it('sortBy=paymentDate + asc → { paymentDate: { sort: asc, nulls: last } }', async () => {
    await service.findAll(
      ORG,
      1,
      20,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      'paymentDate',
      'asc',
    );
    expect(findManyOrderBy()).toEqual({ paymentDate: { sort: 'asc', nulls: 'last' } });
  });

  it('sortBy=totalAmount (non-nullable) → плоска форма { totalAmount: desc }', async () => {
    await service.findAll(
      ORG,
      1,
      20,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      'totalAmount',
      'desc',
    );
    expect(findManyOrderBy()).toEqual({ totalAmount: 'desc' });
  });

  it('без sort-параметрів → default { createdAt: desc } (backward-compat)', async () => {
    await service.findAll(ORG, 1, 20);
    expect(findManyOrderBy()).toEqual({ createdAt: 'desc' });
  });
});
