/**
 * SupplierPaymentsService.create()
 *
 * Виділено з `supplier-payments.service.spec.ts` (був 1410 рядків: 1235 з них — ОДИН
 * top-level describe із 56 тестами БЕЗ вкладених describe, секції розмічені лише
 * ASCII-швами автора) 2026-10-07. Кейси перенесені ДОСЛІВНО.
 *
 * Сетап — `makeSpHarness()` з `./supplier-payments.spec-fixture` (той самий beforeEach).
 */

import { BadRequestException } from '@nestjs/common';
import { PaymentSourceType } from '@prisma/client';
import { it, expect } from 'vitest';
import { supplierPaymentCreateSchema } from '@sto/shared';
import {
  makeSpHarness,
  type SpHarness,
  ORG,
  SUPPLIER_ID,
  BANK_ID,
  CASH_ID,
  USER_ID,
  confirmedRow,
} from './supplier-payments.spec-fixture';

describe('SupplierPaymentsService — create', () => {
  let service: SpHarness['service'];
  let prisma: SpHarness['prisma'];
  let settlements: SpHarness['settlements'];
  let docNumbers: SpHarness['docNumbers'];

  beforeEach(async () => {
    ({ service, prisma, settlements, docNumbers } = await makeSpHarness());
  });

  // ──────────────────────────────────────────────────────────────────────
  // create()
  // ──────────────────────────────────────────────────────────────────────

  // guards: BR-SUPPAY-001
  it('create(): успішне створення з касою → DRAFT, settlement НЕ пишеться', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: SUPPLIER_ID, type: 'SUPPLIER' });
    // TD1: currencyId деривиться з source-рахунку → каса мусить мати currencyId (required у схемі).
    prisma.cashRegister.findFirst.mockResolvedValueOnce({ id: CASH_ID, currencyId: 'uah-cur' });
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

    // BR-SUPPAY-013: номер береться в транзакції створення — відкат повертає його.
    expect(docNumbers.next).toHaveBeenCalledWith(ORG, 'SUPPLIER_PAYMENT', prisma);
    // settlement НЕ пишеться при створенні — тільки при confirm.
    expect(settlements.createTransaction).not.toHaveBeenCalled();
  });

  // guards: BR-SUPPAY-011
  it('create(): валюта оплати — валюта банківського рахунку-джерела', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: SUPPLIER_ID, type: 'SUPPLIER' });
    prisma.bankAccount.findFirst.mockResolvedValueOnce({ id: BANK_ID, currencyId: 'usd-cur' });
    prisma.supplierPayment.create.mockResolvedValueOnce({ ...confirmedRow, status: 'DRAFT' });

    await service.create(
      ORG,
      {
        supplierId: SUPPLIER_ID,
        sourceType: PaymentSourceType.BANK_ACCOUNT,
        bankAccountId: BANK_ID,
        amount: 100,
        method: 'transfer',
      },
      USER_ID,
    );

    const data = prisma.supplierPayment.create.mock.calls[0][0].data as { currencyId: string };
    expect(data.currencyId).toBe('usd-cur');
  });

  // guards: BR-SUPPAY-011
  it('create(): джерело без валюти → 400 sourceHasNoCurrency, без запису', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: SUPPLIER_ID, type: 'SUPPLIER' });
    prisma.cashRegister.findFirst.mockResolvedValueOnce({ id: CASH_ID, currencyId: null });

    await expect(
      service.create(
        ORG,
        {
          supplierId: SUPPLIER_ID,
          sourceType: PaymentSourceType.CASH_REGISTER,
          cashRegisterId: CASH_ID,
          amount: 100,
          method: 'cash',
        },
        USER_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.supplierPayment.create).not.toHaveBeenCalled();
  });

  // guards: BR-SUPPAY-002
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

  // guards: BR-SUPPAY-002
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

  // guards: BR-SUPPAY-003, BR-CP-001
  it('create(): контрагент-CLIENT → BadRequestException (не постачальник)', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: SUPPLIER_ID, type: 'CLIENT' });
    // currencyId обов'язковий у моку: без нього 400 кидав би сусідній guard «рахунок без
    // валюти», і тест лишався б зеленим навіть без перевірки типу контрагента (мутація 2026-10-07).
    prisma.cashRegister.findFirst.mockResolvedValueOnce({ id: CASH_ID, currencyId: 'uah-cur' });
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
    expect(prisma.supplierPayment.create).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Джерело коштів — решта двох гілок ексклюзивності (дві інші — вище)
  // ──────────────────────────────────────────────────────────────────────

  // guards: BR-SUPPAY-002
  it('create(): BANK_ACCOUNT одночасно з cashRegisterId → BadRequestException, БЕЗ DB-виклику', async () => {
    await expect(
      service.create(
        ORG,
        {
          supplierId: SUPPLIER_ID,
          sourceType: PaymentSourceType.BANK_ACCOUNT,
          bankAccountId: BANK_ID,
          cashRegisterId: CASH_ID,
          amount: 500,
          method: 'transfer',
        },
        USER_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Guard спрацьовує ДО читання FK — 400 саме від перевірки джерела, а не від сусідніх.
    expect(prisma.counterparty.findFirst).not.toHaveBeenCalled();
    expect(prisma.supplierPayment.create).not.toHaveBeenCalled();
  });

  // guards: BR-SUPPAY-002
  it('create(): CASH_REGISTER без cashRegisterId → BadRequestException, БЕЗ DB-виклику', async () => {
    await expect(
      service.create(
        ORG,
        {
          supplierId: SUPPLIER_ID,
          sourceType: PaymentSourceType.CASH_REGISTER,
          amount: 500,
          method: 'cash',
        },
        USER_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.counterparty.findFirst).not.toHaveBeenCalled();
    expect(prisma.supplierPayment.create).not.toHaveBeenCalled();
  });
});

describe('supplierPaymentCreateSchema — межі суми (Bug #846)', () => {
  const body = (amount: number) => ({
    supplierId: '11111111-1111-4111-8111-111111111111',
    sourceType: 'CASH_REGISTER',
    cashRegisterId: '22222222-2222-4222-8222-222222222222',
    amount,
    method: 'cash',
  });
  const issues = (amount: number) => {
    const res = supplierPaymentCreateSchema.safeParse(body(amount));
    return res.success ? [] : res.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
  };

  it('сума понад місткість Decimal(12,2) → відмова на полі amount, а не 500 від бази', () => {
    expect(issues(99_999_999_999)).toEqual(['amount: v.supplierPayment.amount.max']);
  });

  it('найбільша сума, яку вміщує колонка, проходить', () => {
    expect(issues(9_999_999_999.99)).toEqual([]);
  });
});
