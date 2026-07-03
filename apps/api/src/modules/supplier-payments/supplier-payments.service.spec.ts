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
    purchaseOrder: { findFirst: ReturnType<typeof vi.fn> };
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
      purchaseOrder: { findFirst: vi.fn() },
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
});
