/**
 * SupplierPaymentsService.confirm() — головний FSM-step
 *
 * Виділено з `supplier-payments.service.spec.ts` (був 1410 рядків: 1235 з них — ОДИН
 * top-level describe із 56 тестами БЕЗ вкладених describe, секції розмічені лише
 * ASCII-швами автора) 2026-10-07. Кейси перенесені ДОСЛІВНО.
 *
 * Сетап — `makeSpHarness()` з `./supplier-payments.spec-fixture` (той самий beforeEach).
 */

import { BadRequestException } from '@nestjs/common';
import { SupplierPaymentStatus, PaymentSourceType } from '@prisma/client';
import { it, expect } from 'vitest';
import {
  makeSpHarness,
  type SpHarness,
  ORG,
  SP_ID,
  SUPPLIER_ID,
  CASH_ID,
  USER_ID,
  confirmedRow,
} from './supplier-payments.spec-fixture';

// Regression-guards для feature "Оплата постачальнику" (SupplierPayment).
// Ключові business invariants на confirm()/cancel() FSM-step:
//   1. confirm() створює settlement PAYMENT (НЕ CHARGE, НЕ REFUND) → наш борг ↓.
//   2. Подвійний confirm() (non-DRAFT re-read) не пише settlement двічі.
//   3. cancel() не пише settlement.
//   4. documentType = 'SupplierPayment' (PascalCase model-name).
//   5. sourceType↔джерело: BANK_ACCOUNT без bankAccountId → BadRequestException.
//   6. Проведену (CONFIRMED) оплату видалити не можна.
describe('SupplierPaymentsService — confirm', () => {
  let service: SpHarness['service'];
  let prisma: SpHarness['prisma'];
  let settlements: SpHarness['settlements'];
  let cash: SpHarness['cash'];

  beforeEach(async () => {
    ({ service, prisma, settlements, cash } = await makeSpHarness());
  });

  // ──────────────────────────────────────────────────────────────────────
  // confirm() — головний FSM-step
  // ──────────────────────────────────────────────────────────────────────

  it('confirm(): settlement SUPPLIER_PAYMENT (+1, наш борг ↓) + documentType=SupplierPayment', async () => {
    prisma.supplierPayment.findFirst
      // pre-tx read: status+supplierId+amount+джерело (для settlement + cash-out). BANK_ACCOUNT → без каси.
      .mockResolvedValueOnce({
        status: SupplierPaymentStatus.DRAFT,
        supplierId: SUPPLIER_ID,
        amount: 500,
        sourceType: PaymentSourceType.BANK_ACCOUNT,
        cashRegisterId: null,
      })
      .mockResolvedValueOnce(confirmedRow); // findOne у кінці
    prisma.supplierPayment.updateMany.mockResolvedValueOnce({ count: 1 }); // CAS DRAFT→CONFIRMED

    await service.confirm(ORG, SP_ID, USER_ID);

    // CAS updateMany where status=DRAFT; data += base-поля (Фаза 3: totalAmountBase/rateUsed).
    expect(prisma.supplierPayment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: SupplierPaymentStatus.DRAFT }),
        data: expect.objectContaining({ status: SupplierPaymentStatus.CONFIRMED }),
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
    // BANK_ACCOUNT джерело → руху готівки немає.
    expect(cash.createOperation).not.toHaveBeenCalled();
  });

  it('confirm(): CASH_REGISTER → cash-out OUT/SUPPLIER_PAYMENT у ту саму tx (Bug — cash-оплата не залишала касу)', async () => {
    prisma.supplierPayment.findFirst
      .mockResolvedValueOnce({
        status: SupplierPaymentStatus.DRAFT,
        supplierId: SUPPLIER_ID,
        amount: 500,
        sourceType: PaymentSourceType.CASH_REGISTER,
        cashRegisterId: CASH_ID,
      })
      .mockResolvedValueOnce(confirmedRow); // findOne у кінці
    prisma.supplierPayment.updateMany.mockResolvedValueOnce({ count: 1 });

    await service.confirm(ORG, SP_ID, USER_ID);

    expect(cash.createOperation).toHaveBeenCalledTimes(1);
    const [orgArg, inputArg, txArg] = cash.createOperation.mock.calls[0]!;
    expect(orgArg).toBe(ORG);
    expect(inputArg).toMatchObject({
      cashRegisterId: CASH_ID,
      direction: 'OUT',
      amount: 500,
      reason: 'SUPPLIER_PAYMENT',
      counterpartyId: SUPPLIER_ID,
      documentType: 'SupplierPayment',
      documentId: SP_ID,
    });
    // ЄДИНА транзакція: cash-out отримує тот самий tx-client, що й settlement (overdraft-guard бачить її стан).
    expect(txArg).toBeDefined();
  });

  it('confirm(): overdraft у касі → createOperation кидає → весь confirm відкат (settlement не «залишається»)', async () => {
    prisma.supplierPayment.findFirst.mockResolvedValueOnce({
      status: SupplierPaymentStatus.DRAFT,
      supplierId: SUPPLIER_ID,
      amount: 500,
      sourceType: PaymentSourceType.CASH_REGISTER,
      cashRegisterId: CASH_ID,
    });
    prisma.supplierPayment.updateMany.mockResolvedValueOnce({ count: 1 });
    // Каса не має вдосталь готівки → overdraft-guard у createOperation кидає 400.
    cash.createOperation.mockRejectedValueOnce(
      new BadRequestException('Недостатньо готівки в касі'),
    );

    await expect(service.confirm(ORG, SP_ID, USER_ID)).rejects.toBeInstanceOf(BadRequestException);
    // settlement викликаний ДО cash-out у тій самій tx → його ефект відкочується разом із помилкою
    // (тут $transaction-мок прокидає помилку; в БД це реальний ROLLBACK). Головне: помилка не проковтнута.
    expect(cash.createOperation).toHaveBeenCalledTimes(1);
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
});
