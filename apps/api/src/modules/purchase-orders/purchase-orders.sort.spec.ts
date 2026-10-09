/**
 * PurchaseOrdersService — findAll — sortBy=paymentDate, nulls-last (Bug #598)
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
        {
          provide: DeliveryTrackingService,
          useValue: { enqueueInitial: vi.fn().mockResolvedValue(undefined) },
        },
        exchangeRatesProvider(),
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

  // Відбір списку за датою. documentDate — дата БЕЗ часу (@db.Date): межі — самі календарні
  // дати, зсуву на київський пояс бути не повинно (він зачепив би попередній день).
  // Mutation-verify: `dateOnlyRangeFilter` → `kyivDayRangeFilter` — обидва кейси з датами падають.
  function findManyWhere() {
    return (
      prisma.purchaseOrder.findMany.mock.calls[0]![0] as {
        where: Record<string, unknown>;
      }
    ).where;
  }

  // guards: BR-PAY-018
  it('dateFrom + dateTo → documentDate від 09.10 до 10.10 календарними датами, без зсуву на пояс', async () => {
    await service.findAll(ORG, 1, 20, undefined, undefined, false, '2026-10-09', '2026-10-10');
    const where = findManyWhere();
    expect(where.documentDate).toEqual({
      gte: new Date('2026-10-09T00:00:00.000Z'),
      lte: new Date('2026-10-10T00:00:00.000Z'),
    });
    expect(where.orgId).toBe(ORG);
    expect((prisma.purchaseOrder.count.mock.calls[0]![0] as { where: unknown }).where).toEqual(
      where,
    );
  });

  // guards: BR-PAY-018
  it('лише dateTo → у documentDate тільки верхня межа, сама дата', async () => {
    await service.findAll(ORG, 1, 20, undefined, undefined, false, undefined, '2026-01-15');
    expect(findManyWhere().documentDate).toEqual({ lte: new Date('2026-01-15T00:00:00.000Z') });
  });

  it('без дат — умови на documentDate немає', async () => {
    await service.findAll(ORG, 1, 20);
    expect(findManyWhere()).not.toHaveProperty('documentDate');
  });
});

// ─── Bug #A + edge inputs: getLinkedCounts / getLinkedDocuments ──────────────
