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
import { OrgPrintInfoService } from '../pdf/org-print-info.service';
import { SettlementsService } from '../settlements/settlements.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { exchangeRatesMock } from './invoices.spec-fixture';
import { memoryTable } from '../cash/cash.spec-fixture';

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
        { provide: OrgPrintInfoService, useValue: {} },
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

  // guards: BR-INV-009
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

  // guards: BR-INV-009
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
    cashOperation: { findMany: ReturnType<typeof vi.fn> };
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
      cashOperation: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const module = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: DocumentNumberService, useValue: { next: vi.fn() } },
        { provide: PdfService, useValue: {} },
        { provide: OrgPrintInfoService, useValue: {} },
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

  // guards: BR-WO-012
  // Мутація: повернути `deletedAt: null` у пошук рахунків getLinkedCounts → нулі у видаленого.
  it('getLinkedCounts: видалений рахунок (список із видаленими) → лічильники як у панелі', async () => {
    const ROWS = [{ id: A, workOrderId: WO, counterpartyId: CP }];
    prisma.invoice.findMany.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(where.deletedAt === null || where.orgId !== ORG ? [] : ROWS),
    );
    prisma.payment.groupBy.mockResolvedValue([]);
    prisma.workOrder.findMany.mockResolvedValue([{ id: WO }]);
    prisma.counterparty.findMany.mockResolvedValue([{ id: CP }]);
    const res = await service.getLinkedCounts(ORG, [A]);
    expect(res[A]).toEqual({ workOrder: 1, payments: 0, counterparty: 1 });
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

  // guards: BR-WO-012
  it('getLinkedDocuments: видалений рахунок (перегляд) → секції заповнені, orgId у пошуку', async () => {
    // Таблиця, що поважає фільтр: з `deletedAt: null` видаленого рахунку не знайти.
    prisma.invoice.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        where.deletedAt === null || where.orgId !== ORG
          ? null
          : { workOrderId: WO, counterpartyId: CP },
      ),
    );
    prisma.workOrder.findFirst.mockResolvedValue({ id: WO, number: 'WO-1', status: 'DONE' });
    prisma.counterparty.findFirst.mockResolvedValue({ id: CP });
    prisma.payment.findMany.mockResolvedValue([]);

    const res = await service.getLinkedDocuments(ORG, A);

    expect(res.workOrder.map(w => w.id)).toEqual([WO]);
    expect(res.counterparty).toEqual([{ id: CP }]);
    // Цілі зв'язків — як і раніше лише живі.
    expect(prisma.workOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    );
    expect(await service.getLinkedDocuments(OTHER_ORG, A)).toEqual({
      workOrder: [],
      payments: [],
      counterparty: [],
    });
  });

  it('getLinkedDocuments: рядок оплати віддає fiscalStatus (select + мапінг), Decimal → number', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ workOrderId: null, counterpartyId: CP });
    prisma.payment.findMany.mockResolvedValue([
      {
        id: 'p1',
        amount: '250.50',
        method: 'CASH',
        createdAt: new Date('2026-10-01T10:00:00Z'),
        notes: null,
        fiscalStatus: 'FAILED',
      },
    ]);
    prisma.counterparty.findFirst.mockResolvedValue(null);

    const res = await service.getLinkedDocuments(ORG, A);

    // Контракт для кнопки «Повторити»: без fiscalStatus у select web не знає про FAILED.
    expect(prisma.payment.findMany.mock.calls[0][0].select).toMatchObject({ fiscalStatus: true });
    expect(res.payments[0]).toMatchObject({ id: 'p1', amount: 250.5, fiscalStatus: 'FAILED' });
  });

  // Дія «Сторнувати» в «Пов'язаних документах» рахунку: касову оплату сторнують у касі, QR — у
  // кабінеті платіжного сервісу. Web вирішує за sourceType і isOnline; id наміру не віддаємо.
  // guards: BR-PAY-024
  it('getLinkedDocuments: рядок оплати віддає sourceType і isOnline, без onlinePaymentIntentId', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ workOrderId: null, counterpartyId: CP });
    const row = {
      amount: '10.00',
      method: 'bank',
      createdAt: new Date('2026-10-01T10:00:00Z'),
      notes: null,
      fiscalStatus: null,
      reversedAt: null,
    };
    prisma.payment.findMany.mockResolvedValue([
      { ...row, id: 'p-cash', sourceType: 'CASH_REGISTER', onlinePaymentIntentId: null },
      { ...row, id: 'p-qr', sourceType: null, onlinePaymentIntentId: 'intent-1' },
    ]);
    prisma.counterparty.findFirst.mockResolvedValue(null);

    const res = await service.getLinkedDocuments(ORG, A);

    expect(prisma.payment.findMany.mock.calls[0][0].select).toMatchObject({
      sourceType: true,
      onlinePaymentIntentId: true,
    });
    expect(res.payments[0]).toMatchObject({ sourceType: 'CASH_REGISTER', isOnline: false });
    expect(res.payments[1]).toMatchObject({ sourceType: null, isOnline: true });
    for (const p of res.payments) expect(p).not.toHaveProperty('onlinePaymentIntentId');
  });

  // Bug #1018: оплата на доларовий рахунок у «Пов'язаних документах» підписувалась «₴» — рядок не
  // мав валюти. Тепер — код валюти оплати; без `currencyId` (базова) — null, сам об'єкт не йде.
  it('getLinkedDocuments: рядок оплати несе currencyCode валюти оплати (null — базова)', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ workOrderId: null, counterpartyId: CP });
    const row = {
      amount: '20.00',
      method: 'bank_transfer',
      createdAt: new Date('2026-10-31T10:00:00Z'),
      notes: null,
      fiscalStatus: null,
      reversedAt: null,
      sourceType: 'BANK_ACCOUNT',
      cashRegisterId: null,
      onlinePaymentIntentId: null,
    };
    prisma.payment.findMany.mockResolvedValue([
      { ...row, id: 'p-usd', currency: { code: 'USD' } },
      { ...row, id: 'p-base', currency: null },
    ]);
    prisma.cashOperation.findMany.mockResolvedValue([]);
    prisma.counterparty.findFirst.mockResolvedValue(null);

    const res = await service.getLinkedDocuments(ORG, A);

    expect(prisma.payment.findMany.mock.calls[0][0].select).toMatchObject({
      currency: { select: { code: true } },
    });
    expect(res.payments[0]).toMatchObject({ id: 'p-usd', currencyCode: 'USD' });
    expect(res.payments[1]).toMatchObject({ id: 'p-base', currencyCode: null });
    for (const p of res.payments) expect(p).not.toHaveProperty('currency');
  });

  // Стара готівкова оплата (до BR-PAY-023) призначення не має, але гроші — у касі: її рядок каси
  // (`documentType = 'Payment'`) чи `cashRegisterId`. Сервер таку сторнує лише в касі
  // (`err.payment.reversalCashRow`), тож рядок оплати каже `inCashDesk` — і web не показує
  // «Сторнувати». Рядки каси читаються таблицею, що виконує `where` (орг, тип, id оплати).
  // guards: BR-PAY-024
  it('getLinkedDocuments: inCashDesk — за sourceType, cashRegisterId або рядком каси своєї org', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ workOrderId: null, counterpartyId: CP });
    const row = {
      amount: '10.00',
      method: 'cash',
      createdAt: new Date('2026-10-01T10:00:00Z'),
      notes: null,
      fiscalStatus: null,
      reversedAt: null,
      onlinePaymentIntentId: null,
    };
    prisma.payment.findMany.mockResolvedValue([
      { ...row, id: 'p-cash', sourceType: 'CASH_REGISTER', cashRegisterId: 'reg-1' },
      { ...row, id: 'p-old-reg', sourceType: null, cashRegisterId: 'reg-1' },
      { ...row, id: 'p-old-row', sourceType: null, cashRegisterId: null },
      { ...row, id: 'p-old-bank', sourceType: null, cashRegisterId: null },
      { ...row, id: 'p-bank', sourceType: 'BANK_ACCOUNT', cashRegisterId: null },
      { ...row, id: 'p-foreign-row', sourceType: null, cashRegisterId: null },
    ]);
    const cashOps = memoryTable([
      { id: 'op-1', orgId: ORG, documentType: 'Payment', documentId: 'p-old-row' },
      { id: 'op-2', orgId: ORG, documentType: 'SupplierPayment', documentId: 'p-old-bank' },
      { id: 'op-3', orgId: OTHER_ORG, documentType: 'Payment', documentId: 'p-foreign-row' },
    ]);
    prisma.cashOperation.findMany = cashOps.findMany;
    prisma.counterparty.findFirst.mockResolvedValue(null);

    const res = await service.getLinkedDocuments(ORG, A);

    expect(prisma.payment.findMany.mock.calls[0][0].select).toMatchObject({
      cashRegisterId: true,
    });
    const inCash = Object.fromEntries(res.payments.map(p => [p.id, p.inCashDesk]));
    expect(inCash).toEqual({
      'p-cash': true,
      'p-old-reg': true,
      'p-old-row': true,
      'p-old-bank': false,
      'p-bank': false,
      'p-foreign-row': false,
    });
    // Рядки каси — один запит на всі оплати, без тих, що касові за самим рядком оплати.
    expect(cashOps.findMany).toHaveBeenCalledTimes(1);
    expect(cashOps.findMany.mock.calls[0]![0]).toMatchObject({
      where: { documentId: { in: ['p-old-row', 'p-old-bank', 'p-bank', 'p-foreign-row'] } },
    });
    for (const p of res.payments) expect(p).not.toHaveProperty('cashRegisterId');
  });
});
