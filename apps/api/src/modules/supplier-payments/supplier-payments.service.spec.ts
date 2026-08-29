import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SupplierPaymentStatus, PaymentSourceType } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SupplierPaymentsService } from './supplier-payments.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DocumentNumberService } from '../document-number/document-number.service';

// Regression-guards для feature "Оплата постачальнику" (SupplierPayment).
// Ключові business invariants на confirm()/cancel() FSM-step:
//   1. confirm() створює settlement PAYMENT (НЕ CHARGE, НЕ REFUND) → наш борг ↓.
//   2. Подвійний confirm() (non-DRAFT re-read) не пише settlement двічі.
//   3. cancel() не пише settlement.
//   4. documentType = 'SupplierPayment' (PascalCase model-name).
//   5. sourceType↔джерело: BANK_ACCOUNT без bankAccountId → BadRequestException.
//   6. Проведену (CONFIRMED) оплату видалити не можна.

describe('SupplierPaymentsService — regression guards', () => {
  let service: SupplierPaymentsService;
  let prisma: {
    supplierPayment: {
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    bankAccount: { findFirst: ReturnType<typeof vi.fn> };
    cashRegister: { findFirst: ReturnType<typeof vi.fn> };
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let settlements: { createTransaction: ReturnType<typeof vi.fn> };
  let docNumbers: { next: ReturnType<typeof vi.fn> };

  const ORG = '00000000-0000-0000-0000-000000000001';
  const SP_ID = '11111111-1111-4111-8111-111111111111';
  const SUPPLIER_ID = '22222222-2222-4222-8222-222222222222';
  const BANK_ID = '33333333-3333-4333-8333-333333333333';
  const CASH_ID = '44444444-4444-4444-8444-444444444444';
  const USER_ID = '77777777-7777-4777-8777-777777777777';

  const confirmedRow = {
    id: SP_ID,
    orgId: ORG,
    number: 'ОПП-20260703-000001',
    status: SupplierPaymentStatus.CONFIRMED,
    supplierId: SUPPLIER_ID,
    sourceType: PaymentSourceType.CASH_REGISTER,
    bankAccountId: null,
    cashRegisterId: CASH_ID,
    purchaseOrderId: null,
    amount: 500,
    method: 'cash',
    notes: null,
    documentDate: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    supplier: { firstName: null, lastName: null, companyName: 'Acme' },
    bankAccount: null,
    cashRegister: { name: 'Каса 1' },
    purchaseOrder: null,
  };

  beforeEach(async () => {
    prisma = {
      supplierPayment: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      counterparty: { findFirst: vi.fn() },
      bankAccount: { findFirst: vi.fn() },
      cashRegister: { findFirst: vi.fn() },
      purchaseOrder: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
    };
    settlements = { createTransaction: vi.fn().mockResolvedValue(undefined) };
    docNumbers = { next: vi.fn().mockResolvedValue('ОПП-20260703-000001') };

    const module = await Test.createTestingModule({
      providers: [
        SupplierPaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettlementsService, useValue: settlements },
        { provide: DocumentNumberService, useValue: docNumbers },
      ],
    }).compile();
    service = module.get(SupplierPaymentsService);
  });

  // ──────────────────────────────────────────────────────────────────────
  // create()
  // ──────────────────────────────────────────────────────────────────────

  it('create(): успішне створення з касою → DRAFT, settlement НЕ пишеться', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: SUPPLIER_ID, type: 'SUPPLIER' });
    prisma.cashRegister.findFirst.mockResolvedValueOnce({ id: CASH_ID });
    prisma.supplierPayment.create.mockResolvedValueOnce({ ...confirmedRow, status: 'DRAFT' });

    await service.create(
      ORG,
      {
        supplierId: SUPPLIER_ID,
        sourceType: PaymentSourceType.CASH_REGISTER,
        cashRegisterId: CASH_ID,
        amount: 500,
        method: 'cash',
      },
      USER_ID,
    );

    expect(docNumbers.next).toHaveBeenCalledWith(ORG, 'SUPPLIER_PAYMENT');
    // settlement НЕ пишеться при створенні — тільки при confirm.
    expect(settlements.createTransaction).not.toHaveBeenCalled();
  });

  it('create(): BANK_ACCOUNT без bankAccountId → BadRequestException', async () => {
    await expect(
      service.create(
        ORG,
        {
          supplierId: SUPPLIER_ID,
          sourceType: PaymentSourceType.BANK_ACCOUNT,
          amount: 500,
          method: 'transfer',
        },
        USER_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(settlements.createTransaction).not.toHaveBeenCalled();
  });

  it('create(): CASH_REGISTER одночасно з bankAccountId → BadRequestException', async () => {
    await expect(
      service.create(
        ORG,
        {
          supplierId: SUPPLIER_ID,
          sourceType: PaymentSourceType.CASH_REGISTER,
          cashRegisterId: CASH_ID,
          bankAccountId: BANK_ID,
          amount: 500,
          method: 'cash',
        },
        USER_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create(): контрагент-CLIENT → BadRequestException (не постачальник)', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: SUPPLIER_ID, type: 'CLIENT' });
    prisma.cashRegister.findFirst.mockResolvedValueOnce({ id: CASH_ID });
    await expect(
      service.create(
        ORG,
        {
          supplierId: SUPPLIER_ID,
          sourceType: PaymentSourceType.CASH_REGISTER,
          cashRegisterId: CASH_ID,
          amount: 500,
          method: 'cash',
        },
        USER_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ──────────────────────────────────────────────────────────────────────
  // confirm() — головний FSM-step
  // ──────────────────────────────────────────────────────────────────────

  it('confirm(): settlement PAYMENT (НЕ CHARGE, НЕ REFUND) + documentType=SupplierPayment', async () => {
    prisma.supplierPayment.findFirst
      .mockResolvedValueOnce({ status: SupplierPaymentStatus.DRAFT }) // pre-check
      .mockResolvedValueOnce({
        status: SupplierPaymentStatus.DRAFT,
        supplierId: SUPPLIER_ID,
        amount: 500,
      }) // re-read у tx
      .mockResolvedValueOnce(confirmedRow); // findOne у кінці

    await service.confirm(ORG, SP_ID, USER_ID);

    expect(settlements.createTransaction).toHaveBeenCalledTimes(1);
    const [orgArg, dtoArg] = settlements.createTransaction.mock.calls[0]!;
    expect(orgArg).toBe(ORG);
    expect(dtoArg).toMatchObject({
      counterpartyId: SUPPLIER_ID,
      type: 'PAYMENT',
      amount: 500,
      documentType: 'SupplierPayment',
      documentId: SP_ID,
      createdBy: USER_ID,
    });
  });

  it('confirm(): non-DRAFT статус (re-read у tx) → BadRequestException, settlement НЕ пишеться', async () => {
    prisma.supplierPayment.findFirst
      .mockResolvedValueOnce({ status: SupplierPaymentStatus.DRAFT }) // pre-check проходить
      .mockResolvedValueOnce({
        status: SupplierPaymentStatus.CONFIRMED,
        supplierId: SUPPLIER_ID,
        amount: 500,
      }); // race: вже CONFIRMED

    await expect(service.confirm(ORG, SP_ID, USER_ID)).rejects.toBeInstanceOf(BadRequestException);
    expect(settlements.createTransaction).not.toHaveBeenCalled();
  });

  it('confirm(): з CANCELLED статусу (pre-check) → BadRequestException', async () => {
    prisma.supplierPayment.findFirst.mockResolvedValueOnce({
      status: SupplierPaymentStatus.CANCELLED,
    });
    await expect(service.confirm(ORG, SP_ID, USER_ID)).rejects.toBeInstanceOf(BadRequestException);
    expect(settlements.createTransaction).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────
  // cancel() / remove()
  // ──────────────────────────────────────────────────────────────────────

  it('cancel(): DRAFT → CANCELLED, settlement НЕ пишеться', async () => {
    prisma.supplierPayment.findFirst
      .mockResolvedValueOnce({ id: SP_ID, status: SupplierPaymentStatus.DRAFT }) // cancel guard
      .mockResolvedValueOnce({ ...confirmedRow, status: SupplierPaymentStatus.CANCELLED }); // findOne

    await service.cancel(ORG, SP_ID);

    expect(settlements.createTransaction).not.toHaveBeenCalled();
    expect(prisma.supplierPayment.update).toHaveBeenCalledWith({
      where: { id: SP_ID, orgId: ORG },
      data: { status: SupplierPaymentStatus.CANCELLED },
    });
  });

  it('remove(): CONFIRMED оплату видалити не можна → BadRequestException', async () => {
    prisma.supplierPayment.findFirst.mockResolvedValueOnce({
      status: SupplierPaymentStatus.CONFIRMED,
    });
    await expect(service.remove(ORG, SP_ID)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('remove(): неіснуюча оплата → NotFoundException', async () => {
    prisma.supplierPayment.findFirst.mockResolvedValueOnce(null);
    await expect(service.remove(ORG, SP_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Bug #589 — regression-guards для create()/update() paths
  // ──────────────────────────────────────────────────────────────────────

  it('create(): невідомий bankAccountId (для BANK_ACCOUNT) → NotFoundException', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: SUPPLIER_ID, type: 'SUPPLIER' });
    prisma.bankAccount.findFirst.mockResolvedValueOnce(null); // не знайдено у org
    await expect(
      service.create(
        ORG,
        {
          supplierId: SUPPLIER_ID,
          sourceType: PaymentSourceType.BANK_ACCOUNT,
          bankAccountId: BANK_ID,
          amount: 500,
          method: 'transfer',
        },
        USER_ID,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.supplierPayment.create).not.toHaveBeenCalled();
  });

  it('create(): purchaseOrder іншого постачальника → BadRequestException (cross-supplier)', async () => {
    const OTHER_SUPPLIER = '88888888-8888-4888-8888-888888888888';
    const PO_ID = '99999999-9999-4999-8999-999999999999';
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: SUPPLIER_ID, type: 'SUPPLIER' });
    prisma.cashRegister.findFirst.mockResolvedValueOnce({ id: CASH_ID });
    prisma.purchaseOrder.findFirst.mockResolvedValueOnce({
      id: PO_ID,
      supplierId: OTHER_SUPPLIER,
    });
    await expect(
      service.create(
        ORG,
        {
          supplierId: SUPPLIER_ID,
          sourceType: PaymentSourceType.CASH_REGISTER,
          cashRegisterId: CASH_ID,
          purchaseOrderId: PO_ID,
          amount: 500,
          method: 'cash',
        },
        USER_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.supplierPayment.create).not.toHaveBeenCalled();
  });

  it('update(): PATCH на CONFIRMED → BadRequestException, ніяких writes', async () => {
    prisma.supplierPayment.findFirst.mockResolvedValueOnce({
      id: SP_ID,
      status: SupplierPaymentStatus.CONFIRMED,
      supplierId: SUPPLIER_ID,
      sourceType: PaymentSourceType.CASH_REGISTER,
      bankAccountId: null,
      cashRegisterId: CASH_ID,
      purchaseOrderId: null,
    });
    await expect(service.update(ORG, SP_ID, { amount: 999 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.supplierPayment.update).not.toHaveBeenCalled();
  });

  it('update(): PATCH sourceType=BANK_ACCOUNT без bankAccountId → BadRequestException', async () => {
    prisma.supplierPayment.findFirst.mockResolvedValueOnce({
      id: SP_ID,
      status: SupplierPaymentStatus.DRAFT,
      supplierId: SUPPLIER_ID,
      sourceType: PaymentSourceType.CASH_REGISTER,
      bankAccountId: null,
      cashRegisterId: CASH_ID,
      purchaseOrderId: null,
    });
    await expect(
      service.update(ORG, SP_ID, { sourceType: PaymentSourceType.BANK_ACCOUNT }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.supplierPayment.update).not.toHaveBeenCalled();
  });

  it('update(): зміна supplierId без purchaseOrderId → авто-очищення orphan PO (Bug #588)', async () => {
    const NEW_SUPPLIER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const OLD_PO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    prisma.supplierPayment.findFirst
      .mockResolvedValueOnce({
        id: SP_ID,
        status: SupplierPaymentStatus.DRAFT,
        supplierId: SUPPLIER_ID,
        sourceType: PaymentSourceType.CASH_REGISTER,
        bankAccountId: null,
        cashRegisterId: CASH_ID,
        purchaseOrderId: OLD_PO, // старий PO належить SUPPLIER_ID
      })
      .mockResolvedValueOnce({ ...confirmedRow, supplierId: NEW_SUPPLIER, purchaseOrderId: null }); // findOne
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: NEW_SUPPLIER, type: 'SUPPLIER' });
    prisma.cashRegister.findFirst.mockResolvedValueOnce({ id: CASH_ID });

    await service.update(ORG, SP_ID, { supplierId: NEW_SUPPLIER });

    // Ключовий assert: у data-payload обов'язково purchaseOrderId: null,
    // навіть без dto.purchaseOrderId у payload — інакше orphan PO старого супʼера.
    expect(prisma.supplierPayment.update).toHaveBeenCalledTimes(1);
    const updateCall = prisma.supplierPayment.update.mock.calls[0]![0] as {
      data: { purchaseOrderId?: string | null; supplierId?: string };
    };
    expect(updateCall.data.purchaseOrderId).toBeNull();
    expect(updateCall.data.supplierId).toBe(NEW_SUPPLIER);
  });

  it('update(): зміна supplierId коли purchaseOrderId вже null → НЕ пише зайвий purchaseOrderId', async () => {
    // Regression: shouldClearOrphanPO лише коли справді orphan (sp.purchaseOrderId != null).
    // Інакше кожен PATCH-supplier робить no-op write на PO поле — audit-shim + sync-noise.
    const NEW_SUPPLIER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    prisma.supplierPayment.findFirst
      .mockResolvedValueOnce({
        id: SP_ID,
        status: SupplierPaymentStatus.DRAFT,
        supplierId: SUPPLIER_ID,
        sourceType: PaymentSourceType.CASH_REGISTER,
        bankAccountId: null,
        cashRegisterId: CASH_ID,
        purchaseOrderId: null, // не було PO — нема чого чистити
      })
      .mockResolvedValueOnce({ ...confirmedRow, supplierId: NEW_SUPPLIER });
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: NEW_SUPPLIER, type: 'SUPPLIER' });
    prisma.cashRegister.findFirst.mockResolvedValueOnce({ id: CASH_ID });

    await service.update(ORG, SP_ID, { supplierId: NEW_SUPPLIER });

    expect(prisma.supplierPayment.update).toHaveBeenCalledTimes(1);
    const updateCall = prisma.supplierPayment.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(updateCall.data).not.toHaveProperty('purchaseOrderId');
  });

  // ──────────────────────────────────────────────────────────────────────
  // findAll() — сортування (whitelist orderBy)
  // ──────────────────────────────────────────────────────────────────────

  function findManyOrderBy() {
    return (
      prisma.supplierPayment.findMany.mock.calls[0]![0] as {
        orderBy: Record<string, string>;
      }
    ).orderBy;
  }

  function findManyWhere() {
    return (
      prisma.supplierPayment.findMany.mock.calls[0]![0] as {
        where: Record<string, unknown>;
      }
    ).where;
  }

  it('findAll(): purchaseOrderId → where.purchaseOrderId (фільтр по замовленню)', async () => {
    const PO_ID = '55555555-5555-4555-8555-555555555555';
    await service.findAll(
      ORG,
      1,
      20,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      PO_ID,
    );
    expect(findManyWhere()).toMatchObject({ orgId: ORG, purchaseOrderId: PO_ID });
  });

  it('findAll(): валідний sortBy=amount + sortDir=asc → orderBy { amount: asc }', async () => {
    await service.findAll(
      ORG,
      1,
      20,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      'amount',
      'asc',
    );
    expect(findManyOrderBy()).toEqual({ amount: 'asc' });
  });

  it('findAll(): sortBy=documentDate → orderBy { documentDate: desc } (default dir)', async () => {
    await service.findAll(
      ORG,
      1,
      20,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      'documentDate',
    );
    expect(findManyOrderBy()).toEqual({ documentDate: 'desc' });
  });

  it('findAll(): невідомий sortBy → fallback orderBy { createdAt: desc }', async () => {
    await service.findAll(
      ORG,
      1,
      20,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      'DROP TABLE',
      'asc',
    );
    // Невідоме поле → повний fallback createdAt desc; asc ігнорується
    // (напрям без валідного поля не має сенсу, інакше garbage sortBy тихо міняє порядок).
    expect(findManyOrderBy()).toEqual({ createdAt: 'desc' });
  });

  it('findAll(): валідне поле + asc зберігає напрям (createdAt asc)', async () => {
    await service.findAll(
      ORG,
      1,
      20,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      'createdAt',
      'asc',
    );
    expect(findManyOrderBy()).toEqual({ createdAt: 'asc' });
  });

  it('findAll(): без sort-параметрів → orderBy { createdAt: desc }', async () => {
    await service.findAll(ORG, 1, 20);
    expect(findManyOrderBy()).toEqual({ createdAt: 'desc' });
  });

  // ──────────────────────────────────────────────────────────────────────
  // getSchedule() — шахматка оплат
  // ──────────────────────────────────────────────────────────────────────

  const poRow = (over: {
    supplierId?: string;
    supplierName?: string;
    totalAmount: number;
    paymentDate: string | null;
    creditLimit?: number | null;
    paid?: number[];
  }) => ({
    id: '99999999-9999-4999-8999-999999999999',
    supplierId: over.supplierId ?? SUPPLIER_ID,
    totalAmount: over.totalAmount,
    paymentDate: over.paymentDate ? new Date(over.paymentDate + 'T00:00:00Z') : null,
    supplier: { firstName: null, lastName: null, companyName: over.supplierName ?? 'Acme' },
    contract: over.creditLimit != null ? { creditLimit: over.creditLimit } : { creditLimit: null },
    supplierPayments: (over.paid ?? []).map(a => ({ amount: a })),
  });

  it('getSchedule(): paymentDate у вікні → сума у byDate; overdue для null/минулого', async () => {
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 1000, paymentDate: '2026-08-10' }), // < from → overdue
      poRow({ totalAmount: 500, paymentDate: null }), // null → overdue
      poRow({ totalAmount: 2000, paymentDate: '2026-08-25' }), // у вікні
      poRow({ totalAmount: 700, paymentDate: '2026-12-31' }), // > to → planned
    ]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    expect(r.dates).toHaveLength(20);
    const row = r.suppliers[0];
    expect(row.overdue).toBe(1500); // 1000 + 500
    expect(row.byDate['2026-08-25']).toBe(2000);
    expect(row.planned).toBe(700);
    expect(row.total).toBe(4200);
    expect(r.totals.total).toBe(4200);
  });

  it('getSchedule(): outstanding = totalAmount − Σ CONFIRMED payments по PO', async () => {
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 1000, paymentDate: '2026-08-25', paid: [300, 200] }), // 500 залишок
      poRow({ totalAmount: 1000, paymentDate: '2026-08-25', paid: [1000] }), // 0 → пропустити
    ]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    expect(r.suppliers[0].byDate['2026-08-25']).toBe(500);
    expect(r.suppliers[0].total).toBe(500);
  });

  it('getSchedule(): кредит-ліміт віднімає з найпізніших (5000 борг, 2000 ліміт → 3000)', async () => {
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 5000, paymentDate: '2026-08-25', creditLimit: 2000 }),
    ]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    // єдина клітинка → ліміт зменшує її з 5000 до 3000
    expect(r.suppliers[0].byDate['2026-08-25']).toBe(3000);
    expect(r.suppliers[0].total).toBe(3000);
  });

  it('getSchedule(): ліміт покриває planned ПЕРШИМ, overdue лишається повним', async () => {
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 1000, paymentDate: '2026-08-10', creditLimit: 1500 }), // overdue 1000
      poRow({ totalAmount: 1000, paymentDate: '2026-12-31', creditLimit: 1500 }), // planned 1000
    ]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    // ліміт 1500: спочатку planned(1000)→0, потім overdue: 1000−500=500
    expect(r.suppliers[0].planned).toBe(0);
    expect(r.suppliers[0].overdue).toBe(500);
    expect(r.suppliers[0].total).toBe(500);
  });

  it('getSchedule(): ліміт ≥ борг → постачальник не показується', async () => {
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 1000, paymentDate: '2026-08-25', creditLimit: 5000 }),
    ]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    expect(r.suppliers).toHaveLength(0);
    expect(r.totals.total).toBe(0);
  });
});
