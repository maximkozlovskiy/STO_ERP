/**
 * PurchaseOrdersService — applyPricing — правила ціноутворення (Bug #187, #200)
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
        {
          provide: DeliveryTrackingService,
          useValue: { enqueueInitial: vi.fn().mockResolvedValue(undefined) },
        },
        exchangeRatesProvider(),
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
