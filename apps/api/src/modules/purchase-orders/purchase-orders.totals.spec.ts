/**
 * PurchaseOrdersService — create — Σ(lines.amount) === totalAmount (Bug #777)
 *
 * Виділено з `purchase-orders.service.spec.ts` (був 1960 рядків, 7 незалежних
 * describe-блоків) 2026-10-05. Кейси перенесені ДОСЛІВНО, жоден it() не змінено:
 * сумарна кількість до і після розбиття — 55, перевірено раннером.
 *
 * Спільні DI-провайдери — `./purchase-orders.spec-fixture`.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
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

describe('PurchaseOrdersService.create — Bug #777: Σ(lines.amount) === totalAmount', () => {
  let service: PurchaseOrdersService;
  let prisma: {
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    warehouse: { findFirst: ReturnType<typeof vi.fn> };
    counterpartyContract: { findFirst: ReturnType<typeof vi.fn> };
    good: { findMany: ReturnType<typeof vi.fn> };
    purchaseOrder: {
      create: ReturnType<typeof vi.fn>;
      findFirstOrThrow: ReturnType<typeof vi.fn>;
    };
    purchaseOrderLine: { createMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };

  const ORG = 'org-777';
  const SUP = '11111111-1111-4111-8111-111111111111';
  const WH = '22222222-2222-4222-8222-222222222222';
  const GOOD = '33333333-3333-4333-8333-333333333333';

  // Дробова кількість (0.5 л × 3.33 грн × 3 рядки): per-line money = 1.67, Σ = 5.01,
  // а round-once(Σ 4.995) = 5.00 → розходження копійки.
  const LINES = [
    { goodId: GOOD, quantity: 0.5, price: 3.33 },
    { goodId: GOOD, quantity: 0.5, price: 3.33 },
    { goodId: GOOD, quantity: 0.5, price: 3.33 },
  ];

  let capturedTotal: number;
  let capturedLines: Array<{ goodId: string; quantity: number; price: number; vatAmount: unknown }>;

  beforeEach(async () => {
    capturedLines = [];
    prisma = {
      counterparty: { findFirst: vi.fn().mockResolvedValue({ id: SUP }) },
      warehouse: { findFirst: vi.fn().mockResolvedValue({ id: WH }) },
      counterpartyContract: { findFirst: vi.fn().mockResolvedValue(null) },
      good: { findMany: vi.fn().mockResolvedValue([{ id: GOOD }]) },
      purchaseOrder: {
        create: vi.fn().mockImplementation(({ data }: { data: { totalAmount: number } }) => {
          capturedTotal = data.totalAmount;
          return Promise.resolve({ id: 'po-777', ...data });
        }),
        // Round-trip: findFirstOrThrow повертає рядки як вони лягли в createMany →
        // toDto перерахує per-line amount = money(q×price), а totalAmount візьме збережений.
        findFirstOrThrow: vi.fn().mockImplementation(() =>
          Promise.resolve({
            id: 'po-777',
            orgId: ORG,
            number: 'PO-777',
            status: PurchaseOrderStatus.DRAFT,
            supplierId: SUP,
            warehouseId: WH,
            contractId: null,
            totalAmount: capturedTotal,
            paidAmount: 0,
            notes: null,
            documentDate: new Date('2026-10-03'),
            createdAt: new Date(),
            updatedAt: new Date(),
            supplier: { firstName: 'S', lastName: '', companyName: null },
            warehouse: { name: 'W' },
            contract: null,
            currency: { code: 'UAH' },
            lines: capturedLines.map((l, i) => ({
              id: `line-${i}`,
              goodId: l.goodId,
              quantity: l.quantity,
              price: l.price,
              vatRate: 0,
              vatAmount: l.vatAmount ?? 0,
              receivedQty: 0,
              good: { name: 'Олива', unit: 'л' },
            })),
          }),
        ),
      },
      purchaseOrderLine: {
        createMany: vi.fn().mockImplementation(({ data }: { data: typeof capturedLines }) => {
          capturedLines = data;
          return Promise.resolve({ count: data.length });
        }),
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
        { provide: DocumentNumberService, useValue: { next: vi.fn().mockResolvedValue('PO-777') } },
        { provide: PricingService, useValue: {} },
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

  it('сума per-line amount дорівнює збереженому totalAmount (дробові кількості)', async () => {
    const dto = { supplierId: SUP, warehouseId: WH, lines: LINES };
    const res = await service.create(ORG, dto as never);

    const sumLines = Math.round(res.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    expect(sumLines).toBe(res.totalAmount);
  });
});
