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
      updateMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    counterpartyContract: { findMany: ReturnType<typeof vi.fn> };
    bankAccount: { findFirst: ReturnType<typeof vi.fn> };
    cashRegister: { findFirst: ReturnType<typeof vi.fn> };
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    settlementAccount: { findMany: ReturnType<typeof vi.fn> };
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
        updateMany: vi.fn().mockResolvedValue({ count: 1 }), // CAS confirm: default success
        create: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      counterparty: { findFirst: vi.fn() },
      counterpartyContract: { findMany: vi.fn().mockResolvedValue([]) },
      bankAccount: { findFirst: vi.fn() },
      cashRegister: { findFirst: vi.fn() },
      purchaseOrder: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      settlementAccount: { findMany: vi.fn().mockResolvedValue([]) },
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

  it('confirm(): settlement SUPPLIER_PAYMENT (+1, наш борг ↓) + documentType=SupplierPayment', async () => {
    prisma.supplierPayment.findFirst
      // pre-tx read: status+supplierId+amount (для settlement).
      .mockResolvedValueOnce({
        status: SupplierPaymentStatus.DRAFT,
        supplierId: SUPPLIER_ID,
        amount: 500,
      })
      .mockResolvedValueOnce(confirmedRow); // findOne у кінці
    prisma.supplierPayment.updateMany.mockResolvedValueOnce({ count: 1 }); // CAS DRAFT→CONFIRMED

    await service.confirm(ORG, SP_ID, USER_ID);

    // CAS updateMany where status=DRAFT.
    expect(prisma.supplierPayment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: SupplierPaymentStatus.DRAFT }),
        data: { status: SupplierPaymentStatus.CONFIRMED },
      }),
    );
    expect(settlements.createTransaction).toHaveBeenCalledTimes(1);
    const [orgArg, dtoArg] = settlements.createTransaction.mock.calls[0]!;
    expect(orgArg).toBe(ORG);
    expect(dtoArg).toMatchObject({
      counterpartyId: SUPPLIER_ID,
      type: 'SUPPLIER_PAYMENT',
      amount: 500,
      documentType: 'SupplierPayment',
      documentId: SP_ID,
      createdBy: USER_ID,
    });
  });

  it('confirm(): CAS програв (updateMany count=0, concurrent) → BadRequest, settlement НЕ пишеться', async () => {
    prisma.supplierPayment.findFirst.mockResolvedValueOnce({
      status: SupplierPaymentStatus.DRAFT, // pre-check проходить
      supplierId: SUPPLIER_ID,
      amount: 500,
    });
    prisma.supplierPayment.updateMany.mockResolvedValueOnce({ count: 0 }); // race: інший уже провів

    await expect(service.confirm(ORG, SP_ID, USER_ID)).rejects.toBeInstanceOf(BadRequestException);
    // MUTATION-VERIFY: settlement НЕ пишеться коли CAS програв (без цього — подвійний SUPPLIER_PAYMENT).
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
    paid?: number[];
  }) => ({
    id: '99999999-9999-4999-8999-999999999999',
    supplierId: over.supplierId ?? SUPPLIER_ID,
    totalAmount: over.totalAmount,
    paymentDate: over.paymentDate ? new Date(over.paymentDate + 'T00:00:00Z') : null,
    supplier: { firstName: null, lastName: null, companyName: over.supplierName ?? 'Acme' },
    supplierPayments: (over.paid ?? []).map(a => ({ amount: a })),
  });

  /** Мок кредит-лімітів (counterpartyContract.findMany). */
  const mockLimit = (limit: number, supplierId = SUPPLIER_ID) =>
    prisma.counterpartyContract.findMany.mockResolvedValueOnce([
      { counterpartyId: supplierId, creditLimit: limit },
    ]);

  /**
   * Мок АВТОРИТЕТНОГО боргу постачальника — SettlementAccount з від'ємним балансом.
   * payable = |balance|; balance зберігаємо від'ємним (ми винні постачальнику).
   */
  const mockPayable = (payable: number, over?: { supplierId?: string; name?: string }) =>
    prisma.settlementAccount.findMany.mockResolvedValueOnce([
      {
        counterpartyId: over?.supplierId ?? SUPPLIER_ID,
        balance: -payable,
        counterparty: { firstName: null, lastName: null, companyName: over?.name ?? 'Acme' },
      },
    ]);

  it('getSchedule(): payable з балансу розподіляється по PO-датах (overdue/byDate/planned)', async () => {
    // Балансовий борг 4200 = точна сума PO-outstanding → FIFO покриває всі PO повністю.
    mockPayable(4200);
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

  it('getSchedule(): FIFO — сума = balance, борг лягає на найстаріші PO (47 vs 30953)', async () => {
    // Ключовий регрес-guard: реальний борг = 47, а PO роздуті до 30953.
    // FIFO наливає 47 на НАЙСТАРІШИЙ PO (953-overdue за датою 08-10, nulls/asc порядок
    // з findMany orderBy) → увесь борг 47 в overdue; PO на 30000 (пізніший) не показується.
    mockPayable(47);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      // Порядок як з findMany: paymentDate asc → 08-10 перший (найстаріший).
      poRow({ totalAmount: 953, paymentDate: '2026-08-10' }), // overdue, найстаріший → бере 47
      poRow({ totalAmount: 30000, paymentDate: '2026-08-25' }), // пізніший → не дійшла черга
    ]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    const row = r.suppliers[0];
    expect(row.total).toBeCloseTo(47, 5);
    expect(row.overdue).toBeCloseTo(47, 5); // увесь борг на найстарішому (overdue)
    expect(row.byDate['2026-08-25']).toBeUndefined(); // пізніший PO не показується
  });

  it('getSchedule(): FIFO часткове перекриття — перший PO повний, другий частково', async () => {
    // payable=1500 наливається: PO[0] (1000) повний, PO[1] (1000) отримує 500, решта відсічена.
    mockPayable(1500);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 1000, paymentDate: '2026-08-25' }), // найстаріший у вікні → 1000
      poRow({ totalAmount: 1000, paymentDate: '2026-08-26' }), // наступний → 500
    ]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    const row = r.suppliers[0];
    expect(row.byDate['2026-08-25']).toBe(1000);
    expect(row.byDate['2026-08-26']).toBe(500);
    expect(row.total).toBe(1500);
  });

  it('getSchedule(): борг з балансу понад суму PO → надлишок в overdue', async () => {
    // payable=1200, єдиний PO outstanding=1000 → 1000 у дату, 200 надлишку → overdue.
    mockPayable(1200);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 1000, paymentDate: '2026-08-25' }),
    ]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    const row = r.suppliers[0];
    expect(row.byDate['2026-08-25']).toBe(1000);
    expect(row.overdue).toBe(200);
    expect(row.total).toBe(1200);
  });

  it('getSchedule(): борг з балансу без відкритих PO → усе в overdue', async () => {
    // Баланс від'ємний (борг з поверненя/коригування), жодного RECEIVED/PARTIAL PO.
    mockPayable(500);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    expect(r.suppliers[0].overdue).toBe(500);
    expect(r.suppliers[0].planned).toBe(0);
    expect(r.suppliers[0].total).toBe(500);
  });

  it('getSchedule(): постачальник з балансом ≥ 0 не показується (нічого не винні)', async () => {
    // Немає SettlementAccount з balance<0 → рядка немає, навіть якщо є відкриті PO.
    prisma.settlementAccount.findMany.mockResolvedValueOnce([]);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 5000, paymentDate: '2026-08-25' }),
    ]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    expect(r.suppliers).toHaveLength(0);
    expect(r.totals.total).toBe(0);
  });

  it('getSchedule(): кредит-ліміт віднімає з найпізніших (5000 борг, 2000 ліміт → 3000)', async () => {
    mockPayable(5000);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 5000, paymentDate: '2026-08-25' }),
    ]);
    mockLimit(2000);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    // єдина клітинка → ліміт зменшує її з 5000 до 3000
    expect(r.suppliers[0].byDate['2026-08-25']).toBe(3000);
    expect(r.suppliers[0].total).toBe(3000);
  });

  it('getSchedule(): ліміт з АКТИВНОГО договору навіть коли PO без contract (review #5)', async () => {
    // PO без contract, але у постачальника є PURCHASE-договір з лімітом → ліміт застосовується.
    mockPayable(5000);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 5000, paymentDate: '2026-08-25' }),
    ]);
    mockLimit(2000);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    expect(r.suppliers[0].total).toBe(3000);
  });

  it('getSchedule(): ліміт покриває planned ПЕРШИМ, overdue лишається повним', async () => {
    mockPayable(2000);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 1000, paymentDate: '2026-08-10' }), // overdue 1000
      poRow({ totalAmount: 1000, paymentDate: '2026-12-31' }), // planned 1000
    ]);
    mockLimit(1500);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    // ліміт 1500: спочатку planned(1000)→0, потім overdue: 1000−500=500
    expect(r.suppliers[0].planned).toBe(0);
    expect(r.suppliers[0].overdue).toBe(500);
    expect(r.suppliers[0].total).toBe(500);
  });

  it('getSchedule(): ліміт ≥ борг → постачальник не показується', async () => {
    mockPayable(1000);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 1000, paymentDate: '2026-08-25' }),
    ]);
    mockLimit(5000);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    expect(r.suppliers).toHaveLength(0);
    expect(r.totals.total).toBe(0);
  });

  it('getSchedule(): SettlementAccount-запит виключає видалених + не-supplier counterparty (Bug #599)', async () => {
    // Bug #599 — payableAccounts має відфільтрувати:
    //   (а) deleted counterparty (orphan-рядки — див. Bug #600 divergence зі звітом);
    //   (б) counterparty.type IN (SUPPLIER, BOTH) — CLIENT з prepayment refund НЕ повинен
    //       з'являтись у графіку оплат ПОСТАЧАЛЬНИКУ.
    // Регресія-guard проти повернення до filter без type-check.
    await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    const where = (
      prisma.settlementAccount.findMany.mock.calls[0]![0] as {
        where: {
          balance?: unknown;
          counterparty?: { deletedAt: null; type?: { in: string[] } };
        };
      }
    ).where;
    expect(where.counterparty).toEqual({
      deletedAt: null,
      type: { in: ['SUPPLIER', 'BOTH'] },
    });
    expect(where.balance).toEqual({ lt: 0 });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Bug #597 — regression guards for cross-field validation.
  // Guards існують у service (from > to → 400, windowDays > 100 → 400),
  // але без тестів наступний refactor може їх видалити → CI green → user
  // отримує 200 з empty/misleading result замість 400 helpful error.
  // Pattern: Bug #416 (Serializable inner re-check test).
  // ──────────────────────────────────────────────────────────────────────

  it('getSchedule(): from > to → BadRequestException, БЕЗ DB-виклику (Bug #597)', async () => {
    await expect(service.getSchedule(ORG, '2026-09-01', '2026-08-30')).rejects.toThrow(
      BadRequestException,
    );
    // DB не мали чіпати — cross-field guard спрацював ДО Promise.all.
    expect(prisma.purchaseOrder.findMany).not.toHaveBeenCalled();
    expect(prisma.settlementAccount.findMany).not.toHaveBeenCalled();
    expect(prisma.counterpartyContract.findMany).not.toHaveBeenCalled();
  });

  it('getSchedule(): вікно > 100 днів → BadRequestException, БЕЗ DB-виклику (Bug #597)', async () => {
    // 2026-01-01 .. 2026-04-30 = 119 днів → windowDays=119 > 100 → 400.
    await expect(service.getSchedule(ORG, '2026-01-01', '2026-04-30')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.purchaseOrder.findMany).not.toHaveBeenCalled();
  });

  it('getSchedule(): windowDays на межі 100 → OK, DB викликано (Bug #597)', async () => {
    // 2026-01-01 .. 2026-04-10 = 99 днів різниці + 23:59:59 → Math.round → 100 → passes strict `> 100`.
    // Регресія-guard: якщо guard стане `>= 100` — цей тест червоний.
    await expect(service.getSchedule(ORG, '2026-01-01', '2026-04-10')).resolves.toBeDefined();
    expect(prisma.purchaseOrder.findMany).toHaveBeenCalledOnce();
  });

  it('getSchedule(): totals.byDate агрегує суми з усіх постачальників по датам (Bug #597)', async () => {
    // Два постачальники, один PO у одну дату, один у іншу.
    // Regression-guard для single-pass reduce (optimize cycle 2) — переконуємось
    // що totals.byDate НЕ пропускає жодного bucket-у і НЕ дублює.
    const SUPPLIER2 = '55555555-5555-4555-8555-555555555555';
    // Баланси = точні суми PO-outstanding → FIFO покриває всі PO повністю для обох.
    prisma.settlementAccount.findMany.mockResolvedValueOnce([
      {
        counterpartyId: SUPPLIER_ID,
        balance: -1600,
        counterparty: { firstName: null, lastName: null, companyName: 'Acme' },
      },
      {
        counterpartyId: SUPPLIER2,
        balance: -400,
        counterparty: { firstName: null, lastName: null, companyName: 'Beta' },
      },
    ]);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poRow({ totalAmount: 1000, paymentDate: '2026-08-25' }), // supplier A → 25-го
      poRow({ totalAmount: 600, paymentDate: '2026-08-26' }), // supplier A → 26-го
      poRow({
        totalAmount: 400,
        paymentDate: '2026-08-25',
        supplierId: SUPPLIER2,
        supplierName: 'Beta',
      }), // supplier B → 25-го
    ]);
    const r = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    // 25-го = 1000 (A) + 400 (B) = 1400
    expect(r.totals.byDate['2026-08-25']).toBe(1400);
    // 26-го = 600 (A)
    expect(r.totals.byDate['2026-08-26']).toBe(600);
    // Порожні колонки не потрапляють у totals.byDate.
    expect(r.totals.byDate['2026-08-27']).toBeUndefined();
    // Sanity: сума збігається з grand total.
    expect(r.totals.total).toBe(2000);
    expect(r.suppliers).toHaveLength(2);
  });

  // ──────────────────────────────────────────────────────────────────────
  // getScheduleDocuments() — drill-down документів клітинки шахматки.
  // Ключовий інваріант: Σ allocated документів у бакеті == сума клітинки getSchedule
  // (спільний computeScheduleAllocations → немає sibling-drift панель↔клітинка).
  // ──────────────────────────────────────────────────────────────────────

  /** PO з унікальним id/number (getScheduleDocuments повертає їх). */
  const poDoc = (over: {
    id: string;
    number: string;
    supplierId?: string;
    supplierName?: string;
    totalAmount: number;
    paymentDate: string | null;
    paid?: number[];
  }) => ({
    id: over.id,
    number: over.number,
    supplierId: over.supplierId ?? SUPPLIER_ID,
    totalAmount: over.totalAmount,
    paymentDate: over.paymentDate ? new Date(over.paymentDate + 'T00:00:00Z') : null,
    supplier: { firstName: null, lastName: null, companyName: over.supplierName ?? 'Acme' },
    supplierPayments: (over.paid ?? []).map(a => ({ amount: a })),
  });

  it('getScheduleDocuments(): date-бакет повертає лише PO цього дня + Σ allocated == клітинка', async () => {
    // 2 PO у 25-го, 1 у 26-го; balance=1600 покриває всі → date 25-го = 1000+400? Ні:
    // FIFO наливає 1600: PO1(1000)@25 повний, PO2(600)@26 повний → 25-го = 1000, 26-го = 600.
    mockPayable(1600);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poDoc({ id: 'po-1', number: 'ЗАМ-1', totalAmount: 1000, paymentDate: '2026-08-25' }),
      poDoc({ id: 'po-2', number: 'ЗАМ-2', totalAmount: 600, paymentDate: '2026-08-26' }),
    ]);
    const docs = await service.getScheduleDocuments(ORG, '2026-08-20', '2026-09-08', {
      kind: 'date',
      date: '2026-08-25',
    });
    expect(docs).toHaveLength(1);
    expect(docs[0].number).toBe('ЗАМ-1');
    expect(docs[0].poId).toBe('po-1');
    const sum = docs.reduce((s, d) => s + d.allocated, 0);
    expect(sum).toBe(1000); // == клітинка byDate['2026-08-25'] у getSchedule
  });

  it('getScheduleDocuments(): overdue-бакет фільтрує лише прострочені/null-date', async () => {
    mockPayable(1500);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poDoc({ id: 'po-o1', number: 'OVR-1', totalAmount: 500, paymentDate: '2026-08-10' }), // overdue
      poDoc({ id: 'po-o2', number: 'OVR-2', totalAmount: 400, paymentDate: null }), // overdue
      poDoc({ id: 'po-d', number: 'DATE-1', totalAmount: 600, paymentDate: '2026-08-25' }), // byDate
    ]);
    const docs = await service.getScheduleDocuments(ORG, '2026-08-20', '2026-09-08', {
      kind: 'overdue',
    });
    expect(docs.map(d => d.number).sort()).toEqual(['OVR-1', 'OVR-2']);
    expect(docs.reduce((s, d) => s + d.allocated, 0)).toBe(900); // 500 + 400
  });

  it('getScheduleDocuments(): planned-бакет — PO поза вікном', async () => {
    mockPayable(700);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poDoc({ id: 'po-p', number: 'PLN-1', totalAmount: 700, paymentDate: '2026-12-31' }),
    ]);
    const docs = await service.getScheduleDocuments(ORG, '2026-08-20', '2026-09-08', {
      kind: 'planned',
    });
    expect(docs).toHaveLength(1);
    expect(docs[0].number).toBe('PLN-1');
    expect(docs[0].allocated).toBe(700);
  });

  it('getScheduleDocuments(): КОНСИСТЕНТНІСТЬ — Σ allocated бакета == клітинка getSchedule (той самий mock)', async () => {
    // Один набір даних → викликаємо ОБИДВА методи → суми мають збігатися по кожному бакету.
    const setup = () => {
      mockPayable(1500);
      prisma.purchaseOrder.findMany.mockResolvedValueOnce([
        poDoc({ id: 'po-a', number: 'A', totalAmount: 1000, paymentDate: '2026-08-25' }),
        poDoc({ id: 'po-b', number: 'B', totalAmount: 1000, paymentDate: '2026-08-26' }),
      ]);
    };
    setup();
    const sched = await service.getSchedule(ORG, '2026-08-20', '2026-09-08');
    setup();
    const docs25 = await service.getScheduleDocuments(ORG, '2026-08-20', '2026-09-08', {
      kind: 'date',
      date: '2026-08-25',
    });
    setup();
    const docs26 = await service.getScheduleDocuments(ORG, '2026-08-20', '2026-09-08', {
      kind: 'date',
      date: '2026-08-26',
    });
    // FIFO: 1500 → 25-го 1000 (повний PO A), 26-го 500 (частковий PO B).
    expect(docs25.reduce((s, d) => s + d.allocated, 0)).toBe(
      sched.suppliers[0].byDate['2026-08-25'],
    );
    expect(docs26.reduce((s, d) => s + d.allocated, 0)).toBe(
      sched.suppliers[0].byDate['2026-08-26'],
    );
    expect(docs25[0].allocated).toBe(1000);
    expect(docs26[0].allocated).toBe(500);
  });

  it('getScheduleDocuments(): кредит-ліміт зменшує allocated з найпізніших', async () => {
    // borg 2000: overdue 1000 + planned 1000; ліміт 1500 з'їдає planned(1000)→0 + overdue 500.
    mockPayable(2000);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poDoc({ id: 'po-ov', number: 'OV', totalAmount: 1000, paymentDate: '2026-08-10' }), // overdue
      poDoc({ id: 'po-pl', number: 'PL', totalAmount: 1000, paymentDate: '2026-12-31' }), // planned
    ]);
    mockLimit(1500);
    const overdueDocs = await service.getScheduleDocuments(ORG, '2026-08-20', '2026-09-08', {
      kind: 'overdue',
    });
    // planned повністю з'їдено лімітом → overdue лишається 500.
    expect(overdueDocs.reduce((s, d) => s + d.allocated, 0)).toBe(500);
  });

  it('getScheduleDocuments(): supplierId звужує запити до одного постачальника', async () => {
    mockPayable(500);
    prisma.purchaseOrder.findMany.mockResolvedValueOnce([
      poDoc({ id: 'po-x', number: 'X', totalAmount: 500, paymentDate: '2026-08-25' }),
    ]);
    await service.getScheduleDocuments(
      ORG,
      '2026-08-20',
      '2026-09-08',
      { kind: 'date', date: '2026-08-25' },
      SUPPLIER_ID,
    );
    // orgId + supplierId у where усіх 3 запитів (tenant + звуження).
    const poWhere = prisma.purchaseOrder.findMany.mock.calls[0]![0].where;
    expect(poWhere.orgId).toBe(ORG);
    expect(poWhere.supplierId).toBe(SUPPLIER_ID);
    const saWhere = prisma.settlementAccount.findMany.mock.calls[0]![0].where;
    expect(saWhere.counterpartyId).toBe(SUPPLIER_ID);
  });

  it('getScheduleDocuments(): from > to → BadRequestException (спільний guard)', async () => {
    await expect(
      service.getScheduleDocuments(ORG, '2026-09-01', '2026-08-30', { kind: 'overdue' }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.purchaseOrder.findMany).not.toHaveBeenCalled();
  });
});

// ─── Bug #A + edge inputs: getLinkedCounts / getLinkedDocuments ──────────────
describe('SupplierPaymentsService — linked-documents edge cases', () => {
  let service: SupplierPaymentsService;
  let prisma: {
    supplierPayment: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    counterparty: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    bankAccount: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    cashRegister: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  };

  const ORG = '00000000-0000-0000-0000-000000000001';
  const OTHER = '00000000-0000-0000-0000-000000000002';
  const SP = '11111111-1111-4111-8111-111111111111';
  const SUP = '22222222-2222-4222-8222-222222222222';
  const BANK = '33333333-3333-4333-8333-333333333333';
  const CASH = '44444444-4444-4444-8444-444444444444';
  const PO = '55555555-5555-4555-8555-555555555555';

  beforeEach(async () => {
    prisma = {
      supplierPayment: { findFirst: vi.fn(), findMany: vi.fn() },
      purchaseOrder: { findFirst: vi.fn(), findMany: vi.fn() },
      counterparty: { findFirst: vi.fn(), findMany: vi.fn() },
      bankAccount: { findFirst: vi.fn(), findMany: vi.fn() },
      cashRegister: { findFirst: vi.fn(), findMany: vi.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [
        SupplierPaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettlementsService, useValue: {} },
        { provide: DocumentNumberService, useValue: {} },
      ],
    }).compile();
    service = module.get(SupplierPaymentsService);
  });

  const setLive = (over: Partial<Record<string, unknown[]>> = {}) => {
    prisma.purchaseOrder.findMany.mockResolvedValue(over.po ?? [{ id: PO }]);
    prisma.counterparty.findMany.mockResolvedValue(over.cp ?? [{ id: SUP }]);
    prisma.bankAccount.findMany.mockResolvedValue(over.bank ?? [{ id: BANK }]);
    prisma.cashRegister.findMany.mockResolvedValue(over.cash ?? [{ id: CASH }]);
  };

  it('getLinkedCounts: bank-оплата → account=1, counterparty=1, PO=1', async () => {
    prisma.supplierPayment.findMany.mockResolvedValue([
      { id: SP, purchaseOrderId: PO, supplierId: SUP, bankAccountId: BANK, cashRegisterId: null },
    ]);
    setLive();
    const res = await service.getLinkedCounts(ORG, [SP]);
    expect(res[SP]).toEqual({ purchaseOrder: 1, counterparty: 1, account: 1 });
  });

  it('getLinkedCounts: без bank і cash → account=0 (не crash)', async () => {
    prisma.supplierPayment.findMany.mockResolvedValue([
      { id: SP, purchaseOrderId: null, supplierId: SUP, bankAccountId: null, cashRegisterId: null },
    ]);
    setLive({ po: [], bank: [], cash: [] });
    const res = await service.getLinkedCounts(ORG, [SP]);
    expect(res[SP]).toEqual({ purchaseOrder: 0, counterparty: 1, account: 0 });
  });

  it('getLinkedCounts: duplicate ids keyed by id', async () => {
    prisma.supplierPayment.findMany.mockResolvedValue([
      { id: SP, purchaseOrderId: PO, supplierId: SUP, bankAccountId: null, cashRegisterId: CASH },
    ]);
    setLive();
    const res = await service.getLinkedCounts(ORG, [SP, SP]);
    expect(Object.keys(res)).toEqual([SP]);
    expect(res[SP].account).toBe(1);
  });

  it('getLinkedCounts: cross-org → нулі, orgId у where', async () => {
    prisma.supplierPayment.findMany.mockResolvedValue([]);
    setLive({ po: [], cp: [], bank: [], cash: [] });
    const res = await service.getLinkedCounts(OTHER, [SP]);
    expect(res[SP]).toEqual({ purchaseOrder: 0, counterparty: 0, account: 0 });
    expect(prisma.supplierPayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orgId: OTHER }) }),
    );
  });

  it('Bug #A: soft-deleted bank account → account count=0 (відповідає detail)', async () => {
    prisma.supplierPayment.findMany.mockResolvedValue([
      { id: SP, purchaseOrderId: null, supplierId: SUP, bankAccountId: BANK, cashRegisterId: null },
    ]);
    setLive({ po: [], bank: [], cash: [] }); // BANK soft-deleted → не в живому наборі
    const res = await service.getLinkedCounts(ORG, [SP]);
    // Дискримінатор: старий код давав account:1 (bankAccountId ? 1 : 0).
    expect(res[SP].account).toBe(0);
    expect(res[SP].counterparty).toBe(1);
  });

  it('Bug #A: soft-deleted постачальник → counterparty count=0', async () => {
    prisma.supplierPayment.findMany.mockResolvedValue([
      { id: SP, purchaseOrderId: null, supplierId: SUP, bankAccountId: null, cashRegisterId: CASH },
    ]);
    setLive({ po: [], cp: [] }); // SUP soft-deleted
    const res = await service.getLinkedCounts(ORG, [SP]);
    expect(res[SP].counterparty).toBe(0);
    expect(res[SP].account).toBe(1);
  });

  it('getLinkedDocuments: cross-org id → порожні секції', async () => {
    prisma.supplierPayment.findFirst.mockResolvedValue(null);
    const res = await service.getLinkedDocuments(OTHER, SP);
    expect(res).toEqual({ purchaseOrder: [], counterparty: [], account: [] });
  });

  it('getLinkedDocuments: bank account soft-deleted → account:[] (не crash)', async () => {
    prisma.supplierPayment.findFirst.mockResolvedValue({
      purchaseOrderId: null,
      supplierId: SUP,
      bankAccountId: BANK,
      cashRegisterId: null,
    });
    prisma.counterparty.findFirst.mockResolvedValue({
      id: SUP,
      firstName: null,
      lastName: null,
      companyName: 'Acme',
      phone: null,
    });
    prisma.bankAccount.findFirst.mockResolvedValue(null); // soft-deleted → deletedAt:null не знайшов
    prisma.cashRegister.findFirst.mockResolvedValue(null);
    const res = await service.getLinkedDocuments(ORG, SP);
    expect(res.account).toEqual([]);
    expect(res.counterparty).toHaveLength(1);
  });
});
