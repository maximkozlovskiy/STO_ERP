/**
 * PurchaseOrdersService — linked-documents — межові випадки
 *
 * Виділено з `purchase-orders.service.spec.ts` (був 1960 рядків, 7 незалежних
 * describe-блоків) 2026-10-05. Кейси перенесені ДОСЛІВНО, жоден it() не змінено:
 * сумарна кількість до і після розбиття — 55, перевірено раннером.
 *
 * Спільні DI-провайдери — `./purchase-orders.spec-fixture`.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PricingService } from '../inventory/pricing.service';
import { SettingsService } from '../settings/settings.service';
import { DeliveryTrackingService } from './delivery/delivery-tracking.service';
import { exchangeRatesProvider } from './purchase-orders.spec-fixture';

describe('PurchaseOrdersService — linked-documents edge cases', () => {
  let service: PurchaseOrdersService;
  let prisma: {
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    supplierPayment: { findMany: ReturnType<typeof vi.fn>; groupBy: ReturnType<typeof vi.fn> };
    counterparty: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  };

  const ORG = 'org-1';
  const OTHER = 'org-2';
  const P = '11111111-1111-4111-8111-111111111111';
  const SUP = '55555555-5555-4555-8555-555555555555';

  beforeEach(async () => {
    prisma = {
      purchaseOrder: { findFirst: vi.fn(), findMany: vi.fn() },
      supplierPayment: { findMany: vi.fn(), groupBy: vi.fn() },
      counterparty: { findFirst: vi.fn(), findMany: vi.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [
        PurchaseOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: {} },
        { provide: SettlementsService, useValue: {} },
        { provide: DocumentNumberService, useValue: {} },
        { provide: PricingService, useValue: {} },
        { provide: SettingsService, useValue: {} },
        {
          provide: DeliveryTrackingService,
          useValue: { enqueueInitial: vi.fn().mockResolvedValue(undefined) },
        },
        exchangeRatesProvider(),
      ],
    }).compile();
    service = module.get(PurchaseOrdersService);
  });

  it('getLinkedCounts: zero-count id → присутній з усіма нулями', async () => {
    prisma.supplierPayment.groupBy.mockResolvedValue([]);
    prisma.purchaseOrder.findMany.mockResolvedValue([{ id: P, supplierId: SUP }]);
    prisma.counterparty.findMany.mockResolvedValue([{ id: SUP }]);
    const res = await service.getLinkedCounts(ORG, [P]);
    expect(res[P]).toEqual({ supplierPayments: 0, counterparty: 1 });
  });

  it('getLinkedCounts: duplicate ids keyed by id, лічильник коректний', async () => {
    prisma.supplierPayment.groupBy.mockResolvedValue([{ purchaseOrderId: P, _count: { id: 2 } }]);
    prisma.purchaseOrder.findMany.mockResolvedValue([{ id: P, supplierId: SUP }]);
    prisma.counterparty.findMany.mockResolvedValue([{ id: SUP }]);
    const res = await service.getLinkedCounts(ORG, [P, P]);
    expect(Object.keys(res)).toEqual([P]);
    expect(res[P]).toEqual({ supplierPayments: 2, counterparty: 1 });
  });

  it('getLinkedCounts: cross-org → нулі, orgId у where', async () => {
    prisma.supplierPayment.groupBy.mockResolvedValue([]);
    prisma.purchaseOrder.findMany.mockResolvedValue([]);
    prisma.counterparty.findMany.mockResolvedValue([]);
    const res = await service.getLinkedCounts(OTHER, [P]);
    expect(res[P]).toEqual({ supplierPayments: 0, counterparty: 0 });
    expect(prisma.supplierPayment.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orgId: OTHER }) }),
    );
  });

  it('Bug #A: soft-deleted постачальник → counterparty count=0', async () => {
    prisma.supplierPayment.groupBy.mockResolvedValue([]);
    prisma.purchaseOrder.findMany.mockResolvedValue([{ id: P, supplierId: SUP }]);
    prisma.counterparty.findMany.mockResolvedValue([]); // SUP soft-deleted
    const res = await service.getLinkedCounts(ORG, [P]);
    // Дискримінатор: старий код давав counterparty:1 (po.supplierId ? 1 : 0).
    expect(res[P].counterparty).toBe(0);
  });

  it('getLinkedDocuments: cross-org id → порожні секції', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue(null);
    const res = await service.getLinkedDocuments(OTHER, P);
    expect(res).toEqual({ supplierPayments: [], counterparty: [] });
    expect(prisma.supplierPayment.findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #777 — ІНВАРІАНТ Σ(рядки) === total на сервісному шляху create (Money-міграція).
//
// Бухгалтер у документі бачить per-line `amount` (toDto рахує money(quantity × price)
// на КОЖЕН рядок) і загальний `totalAmount`. Якщо total порахувати як money(Σ q×p)
// (round-once), а рядки округлюються ПОКРОКОВО — на дробових кількостях (літри/кг,
// quantity — Float) Σ(rounded lines) ≠ round-once(Σ) → документ не б'ється: сума
// рядків 5.01, а total 5.00. Round-once точніший математично, але для документа що
// друкується/експортується рядки МУСЯТЬ дорівнювати total (аудит бухгалтера).
//
// Регресія: цей тест ПАДАЄ на старому коді (totalAmount = money(reduce raw)),
// зеленіє після зміни на sumMoney(per-line money(q×p)).
