/**
 * InvoicesService — toDto paidAmount authority (Bug #676) + пов'язані документи
 *
 * Виділено з `invoices.service.spec.ts` (був 1244 рядки; 1011 з них — ОДИН top-level
 * describe із 10 вкладеними під спільним 85-рядковим beforeEach) 2026-10-06.
 * Кейси перенесені ДОСЛІВНО; вкладені describe підняті на top-level, тому їхній
 * `fullName` втратив префікс 'InvoicesService — business logic guards' — єдина
 * свідома зміна, baseline оновлено відповідно.
 *
 * Сетап — `makeInvoicesHarness()` з `./invoices.spec-fixture` (той самий beforeEach).
 */

import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PdfService } from '../pdf/pdf.service';
import { SettlementsService } from '../settlements/settlements.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { exchangeRatesMock } from './invoices.spec-fixture';

// ─── Session 2026-09-06: toDto paidAmount column authority (Bug #676) ─────────
//
// toDto віддає РЕАЛЬНУ колонку paidAmount (авторитетну, транзакційно оновлювану), НЕ
// суму payments. Фолбек на Σpayments лише коли колонки немає у вибірці (старий шлях).
// PARTIALLY_PAID має коректно потрапляти у status відповіді.
describe('InvoicesService — toDto paidAmount authority (Bug #676)', () => {
  let service: InvoicesService;
  let prisma: { invoice: { findFirst: ReturnType<typeof vi.fn> } };

  const ORG = 'org-1';
  const INV_ID = '22222222-2222-4222-8222-222222222222';

  const baseInv = {
    id: INV_ID,
    orgId: ORG,
    number: 'INV-1',
    counterpartyId: 'c-1',
    workOrderId: null,
    invoiceType: 'INVOICE',
    notes: null,
    dueDate: null,
    documentDate: new Date('2026-01-01'),
    deletedAt: null,
    totalWithoutVat: 0,
    totalVat: 0,
    totalWithVat: 500,
    createdAt: new Date(),
    updatedAt: new Date(),
    counterparty: { firstName: null, lastName: null, companyName: 'ТОВ' },
    workOrder: null,
    lines: [],
  };

  beforeEach(async () => {
    prisma = { invoice: { findFirst: vi.fn() } };
    const module = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: DocumentNumberService, useValue: { next: vi.fn() } },
        { provide: PdfService, useValue: {} },
        { provide: SettlementsService, useValue: {} },
        {
          provide: SettingsService,
          useValue: {
            getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }),
          },
        },
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        exchangeRatesMock(),
      ],
    }).compile();
    service = module.get(InvoicesService);
  });

  it('віддає paidAmount з колонки (200), навіть якщо Σpayments розходиться (999)', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      ...baseInv,
      status: 'PARTIALLY_PAID',
      amount: 500,
      paidAmount: 200, // авторитетна колонка
      payments: [{ amount: 999 }], // навмисно розбіжна сума — НЕ має вплинути
    });

    const dto = await service.findOne(ORG, INV_ID);

    expect(dto.paidAmount).toBe(200);
    expect(dto.status).toBe('PARTIALLY_PAID');
  });

  it('фолбек на Σpayments лише коли колонки paidAmount немає у вибірці', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      ...baseInv,
      status: 'SENT',
      amount: 500,
      paidAmount: null, // колонка відсутня → фолбек
      payments: [{ amount: 100 }, { amount: 50 }],
    });

    const dto = await service.findOne(ORG, INV_ID);

    expect(dto.paidAmount).toBe(150);
  });

  it('paidAmount=0 (колонка є, ще нічого не оплачено) → 0, не undefined/фолбек', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      ...baseInv,
      status: 'SENT',
      amount: 500,
      paidAmount: 0,
      payments: [{ amount: 777 }], // не має протекти
    });

    const dto = await service.findOne(ORG, INV_ID);

    expect(dto.paidAmount).toBe(0);
  });
});

// ─── Bug #A + edge inputs: getLinkedCounts / getLinkedDocuments ──────────────
describe('InvoicesService — linked-documents edge cases', () => {
  let service: InvoicesService;
  let prisma: {
    invoice: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    workOrder: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    counterparty: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    payment: { findMany: ReturnType<typeof vi.fn>; groupBy: ReturnType<typeof vi.fn> };
  };

  const ORG = 'org-1';
  const OTHER_ORG = 'org-2';
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const WO = '33333333-3333-4333-8333-333333333333';
  const CP = '44444444-4444-4444-8444-444444444444';

  beforeEach(async () => {
    prisma = {
      invoice: { findFirst: vi.fn(), findMany: vi.fn() },
      workOrder: { findFirst: vi.fn(), findMany: vi.fn() },
      counterparty: { findFirst: vi.fn(), findMany: vi.fn() },
      payment: { findMany: vi.fn(), groupBy: vi.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: DocumentNumberService, useValue: { next: vi.fn() } },
        { provide: PdfService, useValue: {} },
        { provide: SettlementsService, useValue: {} },
        {
          provide: SettingsService,
          useValue: {
            getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }),
          },
        },
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        exchangeRatesMock(),
      ],
    }).compile();
    service = module.get(InvoicesService);
  });

  it('getLinkedCounts: zero-count id присутній у мапі з усіма нулями (не absent)', async () => {
    prisma.invoice.findMany.mockResolvedValue([{ id: A, workOrderId: null, counterpartyId: null }]);
    prisma.payment.groupBy.mockResolvedValue([]);
    prisma.workOrder.findMany.mockResolvedValue([]);
    prisma.counterparty.findMany.mockResolvedValue([]);

    const res = await service.getLinkedCounts(ORG, [A]);
    expect(res[A]).toEqual({ workOrder: 0, payments: 0, counterparty: 0 });
  });

  it('getLinkedCounts: duplicate ids у запиті не ламають мапу (keyed by id)', async () => {
    prisma.invoice.findMany.mockResolvedValue([{ id: A, workOrderId: WO, counterpartyId: CP }]);
    prisma.payment.groupBy.mockResolvedValue([{ invoiceId: A, _count: { id: 3 } }]);
    prisma.workOrder.findMany.mockResolvedValue([{ id: WO }]);
    prisma.counterparty.findMany.mockResolvedValue([{ id: CP }]);

    const res = await service.getLinkedCounts(ORG, [A, A, A]);
    expect(Object.keys(res)).toEqual([A]);
    expect(res[A]).toEqual({ workOrder: 1, payments: 3, counterparty: 1 });
  });

  it('getLinkedCounts: cross-org id → всі нулі, чужі дані не протікають', async () => {
    // findMany scoped by orgId → чужий рахунок не повертається.
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.payment.groupBy.mockResolvedValue([]);
    prisma.workOrder.findMany.mockResolvedValue([]);
    prisma.counterparty.findMany.mockResolvedValue([]);

    const res = await service.getLinkedCounts(OTHER_ORG, [A, B]);
    expect(res[A]).toEqual({ workOrder: 0, payments: 0, counterparty: 0 });
    expect(res[B]).toEqual({ workOrder: 0, payments: 0, counterparty: 0 });
    // orgId дійсно у where групуючого запиту
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orgId: OTHER_ORG }) }),
    );
  });

  it('Bug #A: soft-deleted контрагент → count=0 (відповідає порожній detail-секції)', async () => {
    // FK присутній, але counterparty.findMany (deletedAt:null) НЕ повертає його.
    prisma.invoice.findMany.mockResolvedValue([{ id: A, workOrderId: WO, counterpartyId: CP }]);
    prisma.payment.groupBy.mockResolvedValue([]);
    prisma.workOrder.findMany.mockResolvedValue([{ id: WO }]);
    prisma.counterparty.findMany.mockResolvedValue([]); // CP soft-deleted → не в живому наборі

    const res = await service.getLinkedCounts(ORG, [A]);
    // Дискримінатор: старий код давав counterparty:1 (inv.counterpartyId ? 1 : 0).
    expect(res[A].counterparty).toBe(0);
    expect(res[A].workOrder).toBe(1);
  });

  it('getLinkedDocuments: cross-org id → порожні секції, не чужі дані', async () => {
    prisma.invoice.findFirst.mockResolvedValue(null); // findFirst orgId-scoped → null
    const res = await service.getLinkedDocuments(OTHER_ORG, A);
    expect(res).toEqual({ workOrder: [], payments: [], counterparty: [] });
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });
});
