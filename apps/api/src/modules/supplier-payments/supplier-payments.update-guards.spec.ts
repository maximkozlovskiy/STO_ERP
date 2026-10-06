/**
 * SupplierPaymentsService — guards create()/update() (Bug #589)
 *
 * Виділено з `supplier-payments.service.spec.ts` (був 1410 рядків: 1235 з них — ОДИН
 * top-level describe із 56 тестами БЕЗ вкладених describe, секції розмічені лише
 * ASCII-швами автора) 2026-10-07. Кейси перенесені ДОСЛІВНО.
 *
 * Сетап — `makeSpHarness()` з `./supplier-payments.spec-fixture` (той самий beforeEach).
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SupplierPaymentStatus, PaymentSourceType } from '@prisma/client';
import { it, expect } from 'vitest';
import {
  makeSpHarness,
  type SpHarness,
  ORG,
  SP_ID,
  SUPPLIER_ID,
  BANK_ID,
  CASH_ID,
  USER_ID,
  confirmedRow,
} from './supplier-payments.spec-fixture';

describe('SupplierPaymentsService — update-guards', () => {
  let service: SpHarness['service'];
  let prisma: SpHarness['prisma'];

  beforeEach(async () => {
    ({ service, prisma } = await makeSpHarness());
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
});
