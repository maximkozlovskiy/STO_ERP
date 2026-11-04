/**
 * InvoicesService.update — очищення нотаток чернетки рахунку
 *
 * Аспект: картка рахунку очищає «Примітки» → PATCH 200, а в БД лишалось старе значення
 * (TECH-DEBT (а) 2026-11-01). Дві причини: `invoiceUpdateSchema` робив з '' і null `undefined`,
 * а сервіс писав `notes: dto.notes ?? undefined` — навіть явний `null` до Prisma не доходив.
 * Тепер: '' / null → `null` у `prisma.invoice.update`; ключа немає → `notes` не чіпається.
 *
 * Термін оплати (`dueDate`, `DateTime?`) — так само (TECH-DEBT (а) 2026-11-04): сервіс писав
 * `dto.dueDate ? new Date(…) : undefined`, і null не доходив. `documentDate` — NOT NULL, не очищається.
 *
 * Сетап — `makeInvoicesHarness()` з `./invoices.spec-fixture`; тіло проходить ту саму
 * `ZodValidationPipe(invoiceUpdateSchema)`, що й контролер.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { invoiceUpdateSchema, type InvoiceUpdateValues } from '@sto/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { makeInvoicesHarness, ORG, INV_ID, type InvoicesHarness } from './invoices.spec-fixture';

const pipe = (body: Record<string, unknown>) =>
  new ZodValidationPipe<InvoiceUpdateValues>(invoiceUpdateSchema).transform(body);

describe('InvoicesService — update: очищення нотаток', () => {
  let service: InvoicesHarness['service'];
  let prisma: InvoicesHarness['prisma'];

  beforeEach(async () => {
    ({ service, prisma } = await makeInvoicesHarness());
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'DRAFT',
      counterpartyId: null,
      workOrderId: null,
    });
    prisma.invoice.update.mockResolvedValue({
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
      counterpartyId: null,
      counterparty: { firstName: null, lastName: null, companyName: 'ТОВ' },
      workOrder: null,
    });
  });

  const writtenData = (): Record<string, unknown> =>
    (prisma.invoice.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;

  it.each([[''], [null]])('notes %j з картки → notes: null у prisma.invoice.update', async raw => {
    await service.update(ORG, INV_ID, pipe({ notes: raw }));
    expect(writtenData()).toHaveProperty('notes', null);
  });

  it('notes не передано → поле не чіпається (undefined у data)', async () => {
    await service.update(ORG, INV_ID, pipe({ amount: 100 }));
    expect(writtenData().notes).toBeUndefined();
  });

  it('нове значення нотаток пишеться як є', async () => {
    await service.update(ORG, INV_ID, pipe({ notes: 'Оплата до п’ятниці' }));
    expect(writtenData().notes).toBe('Оплата до п’ятниці');
  });

  // Мутація: повернути `dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined` → кейси '' / null
  // червоніють (undefined замість null).
  it.each([[''], [null]])(
    'dueDate %j з картки → dueDate: null у prisma.invoice.update',
    async raw => {
      await service.update(ORG, INV_ID, pipe({ dueDate: raw }));
      expect(writtenData()).toHaveProperty('dueDate', null);
    },
  );

  it('dueDate не передано → термін не чіпається', async () => {
    await service.update(ORG, INV_ID, pipe({ notes: 'x' }));
    expect(writtenData().dueDate).toBeUndefined();
  });

  it('нова дата терміну → Date', async () => {
    await service.update(ORG, INV_ID, pipe({ dueDate: '2026-12-01' }));
    expect(writtenData().dueDate).toEqual(new Date('2026-12-01'));
  });

  it("documentDate '' / null → не чіпається (колонка NOT NULL)", async () => {
    await service.update(ORG, INV_ID, pipe({ documentDate: '' }));
    await service.update(ORG, INV_ID, pipe({ documentDate: null }));
    for (const call of prisma.invoice.update.mock.calls)
      expect((call[0] as { data: Record<string, unknown> }).data.documentDate).toBeUndefined();
  });
});
