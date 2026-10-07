/**
 * InvoicesService.update — зміна контрагента чернетки рахунку
 *
 * Аспект: `counterpartyId` у PATCH — це FK з тіла запиту. До 2026-10-08 update писав його
 * як є: без перевірки належності до org (рахунок можна було переписати на контрагента чужої
 * організації) і повз BR-CP-001, який create і clone вже тримали.
 *
 *   BR-CP-001 — рахунок виставляється клієнту: SUPPLIER → 400, CLIENT / BOTH проходять.
 *               Перевіряється лише ЗМІНА контрагента — рахунок, створений раніше на
 *               постачальника, лишається редагованим.
 *
 * Сетап — `makeInvoicesHarness()` з `./invoices.spec-fixture`.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, it, expect, beforeEach } from 'vitest';
import { makeInvoicesHarness, ORG, INV_ID, type InvoicesHarness } from './invoices.spec-fixture';

describe('InvoicesService — update: зміна контрагента', () => {
  let service: InvoicesHarness['service'];
  let prisma: InvoicesHarness['prisma'];

  const CURRENT_CP = '44444444-4444-4444-8444-444444444444';
  const NEW_CP = '55555555-5555-4555-8555-555555555555';

  beforeEach(async () => {
    ({ service, prisma } = await makeInvoicesHarness());
    prisma.invoice.findFirst.mockResolvedValue({ status: 'DRAFT', counterpartyId: CURRENT_CP });
    prisma.invoice.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: INV_ID,
        orgId: ORG,
        number: 'INV-2026-0001',
        status: 'DRAFT',
        amount: 100,
        notes: null,
        dueDate: null,
        deletedAt: null,
        totalWithoutVat: 0,
        totalVat: 0,
        totalWithVat: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        workOrderId: null,
        counterpartyId: (data.counterpartyId as string | undefined) ?? CURRENT_CP,
        counterparty: { firstName: null, lastName: null, companyName: 'ТОВ' },
        workOrder: null,
      }),
    );
  });

  it('новий контрагент шукається в межах org серед невидалених', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({ id: NEW_CP, type: 'CLIENT' });

    await service.update(ORG, INV_ID, { counterpartyId: NEW_CP });

    expect(prisma.counterparty.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: NEW_CP, orgId: ORG, deletedAt: null } }),
    );
    expect(prisma.invoice.update.mock.calls[0][0].data.counterpartyId).toBe(NEW_CP);
  });

  it('контрагента немає в цій org (чужий або видалений) → 404, рахунок не пишеться', async () => {
    prisma.counterparty.findFirst.mockResolvedValue(null);

    await expect(service.update(ORG, INV_ID, { counterpartyId: NEW_CP })).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  // guards: BR-CP-001
  it('новий контрагент — постачальник → 400, рахунок не пишеться', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({ id: NEW_CP, type: 'SUPPLIER' });

    await expect(service.update(ORG, INV_ID, { counterpartyId: NEW_CP })).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  // guards: BR-CP-001
  it('новий контрагент типу BOTH → проходить', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({ id: NEW_CP, type: 'BOTH' });

    await expect(service.update(ORG, INV_ID, { counterpartyId: NEW_CP })).resolves.toBeDefined();
  });

  // guards: BR-CP-001
  it('той самий контрагент (старий рахунок на постачальника) → без перевірки, правка проходить', async () => {
    await expect(
      service.update(ORG, INV_ID, { counterpartyId: CURRENT_CP, notes: 'нове' }),
    ).resolves.toBeDefined();

    expect(prisma.counterparty.findFirst).not.toHaveBeenCalled();
    expect(prisma.invoice.update).toHaveBeenCalledTimes(1);
  });
});
