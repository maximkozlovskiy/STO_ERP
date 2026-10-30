/**
 * SupplierPaymentsService — guards create() (Bug #589)
 *
 * Виділено з `supplier-payments.service.spec.ts` (був 1410 рядків: 1235 з них — ОДИН
 * top-level describe із 56 тестами БЕЗ вкладених describe, секції розмічені лише
 * ASCII-швами автора) 2026-10-07. Кейси перенесені ДОСЛІВНО.
 *
 * Сетап — `makeSpHarness()` з `./supplier-payments.spec-fixture` (той самий beforeEach).
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PaymentSourceType } from '@prisma/client';
import { it, expect } from 'vitest';
import {
  makeSpHarness,
  type SpHarness,
  ORG,
  SUPPLIER_ID,
  BANK_ID,
  CASH_ID,
  USER_ID,
} from './supplier-payments.spec-fixture';

describe('SupplierPaymentsService — create-guards', () => {
  let service: SpHarness['service'];
  let prisma: SpHarness['prisma'];

  beforeEach(async () => {
    ({ service, prisma } = await makeSpHarness());
  });

  // ──────────────────────────────────────────────────────────────────────
  // Bug #589 — regression-guards для create() (update() і PATCH прибрано 2026-10-30)
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

  // guards: BR-SUPPAY-004
  it('create(): purchaseOrder іншого постачальника → BadRequestException (cross-supplier)', async () => {
    const OTHER_SUPPLIER = '88888888-8888-4888-8888-888888888888';
    const PO_ID = '99999999-9999-4999-8999-999999999999';
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: SUPPLIER_ID, type: 'SUPPLIER' });
    // currencyId обов'язковий у моку: без нього 400 кидав би guard «рахунок без валюти»,
    // і тест не помічав би зникнення cross-supplier перевірки (мутація 2026-10-07).
    prisma.cashRegister.findFirst.mockResolvedValueOnce({ id: CASH_ID, currencyId: 'uah-cur' });
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
});
