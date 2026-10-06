/**
 * SupplierReturnsService — Σ(lines.amount) === totalAmount (Bug #778)
 *
 * Виділено з `supplier-returns.service.spec.ts` (був 913 рядків, 5 незалежних
 * top-level describe) 2026-10-05. Кейси перенесені ДОСЛІВНО, назви describe не
 * змінені — інакше `fullName` у test-baseline.json розійшовся б.
 */

import { Test } from '@nestjs/testing';
import { SupplierReturnStatus } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SupplierReturnsService } from './supplier-returns.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DocumentNumberService } from '../document-number/document-number.service';

// ─────────────────────────────────────────────────────────────────────────────
// Bug #778 — ІНВАРІАНТ Σ(рядки) === total на сервісному шляху create (Money).
// toDto показує бухгалтеру per-line amount = money(q×price); total мусить їм дорівнювати.
// На дробовій кількості (quantity — Float: літри/кг) round-once(Σ) розходиться з
// Σ(per-line rounded). ПАДАЄ на старому коді (money(reduce raw)), зеленіє після sumMoney.
describe('SupplierReturnsService.create — Bug #778: Σ(lines.amount) === totalAmount', () => {
  let service: SupplierReturnsService;
  let prisma: {
    supplierReturn: { create: ReturnType<typeof vi.fn> };
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    warehouse: { findFirst: ReturnType<typeof vi.fn> };
    good: { findMany: ReturnType<typeof vi.fn> };
    unitOfMeasure: { findMany: ReturnType<typeof vi.fn> };
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn> };
  };

  const ORG = '00000000-0000-4000-8000-0000000007aa';
  const SUPPLIER_ID = '22222222-2222-4222-8222-222222222222';
  const WAREHOUSE_ID = '33333333-3333-4333-8333-333333333333';
  // РІЗНІ goodId — SR дедуплікує рядки за goodId (deduplicateBy), однакові збились би в один.
  const GOOD_A = '44444444-4444-4444-8444-44444444444a';
  const GOOD_B = '44444444-4444-4444-8444-44444444444b';
  const GOOD_C = '44444444-4444-4444-8444-44444444444c';

  const LINES = [
    { goodId: GOOD_A, quantity: 0.5, price: 3.33 },
    { goodId: GOOD_B, quantity: 0.5, price: 3.33 },
    { goodId: GOOD_C, quantity: 0.5, price: 3.33 },
  ];

  beforeEach(async () => {
    prisma = {
      supplierReturn: {
        create: vi.fn().mockImplementation(
          ({
            data,
          }: {
            data: {
              totalAmount: number;
              lines: { create: Array<{ goodId: string; quantity: number; price: number }> };
            };
          }) =>
            Promise.resolve({
              id: 'sr-777',
              orgId: ORG,
              number: 'ПВП-777',
              status: SupplierReturnStatus.DRAFT,
              supplierId: SUPPLIER_ID,
              warehouseId: WAREHOUSE_ID,
              purchaseOrderId: null,
              totalAmount: data.totalAmount,
              notes: null,
              documentDate: new Date('2026-10-03'),
              createdAt: new Date(),
              updatedAt: new Date(),
              supplier: { firstName: null, lastName: null, companyName: 'ТОВ Постач' },
              warehouse: { name: 'Склад 1' },
              purchaseOrder: null,
              lines: data.lines.create.map((l, i) => ({
                id: `line-${i}`,
                goodId: l.goodId,
                quantity: l.quantity,
                price: l.price,
                unitOfMeasureId: null,
                good: { name: 'Олива', sku: null, unit: 'л', unitOfMeasure: { shortName: 'л' } },
              })),
            }),
        ),
      },
      counterparty: { findFirst: vi.fn().mockResolvedValue({ id: SUPPLIER_ID }) },
      warehouse: { findFirst: vi.fn().mockResolvedValue({ id: WAREHOUSE_ID }) },
      good: {
        findMany: vi.fn().mockResolvedValue([{ id: GOOD_A }, { id: GOOD_B }, { id: GOOD_C }]),
      },
      unitOfMeasure: { findMany: vi.fn().mockResolvedValue([]) },
      purchaseOrder: { findFirst: vi.fn() },
    };

    const module = await Test.createTestingModule({
      providers: [
        SupplierReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: InventoryService, useValue: {} },
        { provide: SettlementsService, useValue: {} },
        {
          provide: DocumentNumberService,
          useValue: { next: vi.fn().mockResolvedValue('ПВП-777') },
        },
      ],
    }).compile();
    service = module.get(SupplierReturnsService);
  });

  it('сума per-line amount дорівнює збереженому totalAmount (дробові кількості)', async () => {
    const res = await service.create(ORG, {
      supplierId: SUPPLIER_ID,
      warehouseId: WAREHOUSE_ID,
      lines: LINES,
    } as never);

    const sumLines = Math.round(res.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    expect(sumLines).toBe(res.totalAmount);
  });
});
