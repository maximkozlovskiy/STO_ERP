/**
 * SupplierPaymentsService.cancel() / remove()
 *
 * Виділено з `supplier-payments.service.spec.ts` (був 1410 рядків: 1235 з них — ОДИН
 * top-level describe із 56 тестами БЕЗ вкладених describe, секції розмічені лише
 * ASCII-швами автора) 2026-10-07. Кейси перенесені ДОСЛІВНО.
 *
 * Сетап — `makeSpHarness()` з `./supplier-payments.spec-fixture` (той самий beforeEach).
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SupplierPaymentStatus } from '@prisma/client';
import { it, expect } from 'vitest';
import {
  makeSpHarness,
  type SpHarness,
  ORG,
  SP_ID,
  confirmedRow,
} from './supplier-payments.spec-fixture';

describe('SupplierPaymentsService — cancel-remove', () => {
  let service: SpHarness['service'];
  let prisma: SpHarness['prisma'];
  let settlements: SpHarness['settlements'];

  beforeEach(async () => {
    ({ service, prisma, settlements } = await makeSpHarness());
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

  // guards: BR-SUPPAY-006
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
