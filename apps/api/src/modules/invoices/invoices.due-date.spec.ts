/**
 * InvoicesService.create — dueDate за invoiceDueDays (§13)
 *
 * Виділено з `invoices.service.spec.ts` (був 1244 рядки; 1011 з них — ОДИН top-level
 * describe із 10 вкладеними під спільним 85-рядковим beforeEach) 2026-10-06.
 * Кейси перенесені ДОСЛІВНО; вкладені describe підняті на top-level, тому їхній
 * `fullName` втратив префікс 'InvoicesService — business logic guards' — єдина
 * свідома зміна, baseline оновлено відповідно.
 *
 * Сетап — `makeInvoicesHarness()` з `./invoices.spec-fixture` (той самий beforeEach).
 */

import { describe, it, expect } from 'vitest';
import { makeInvoicesHarness, ORG, INV_ID, type InvoicesHarness } from './invoices.spec-fixture';

describe('InvoicesService — due-date', () => {
  // Деструктуризація у ТІ САМІ імена, що були у вихідному beforeEach — щоб жоден
  // it() не правився (інакше це вже не «перенесено дослівно»).
  let service: InvoicesHarness['service'];
  let prisma: InvoicesHarness['prisma'];
  let settingsMock: InvoicesHarness['settings'];

  beforeEach(async () => {
    ({ service, prisma, settings: settingsMock } = await makeInvoicesHarness());
  });

  // §13 config-over-hardcode: дефолтний термін оплати = documentDate + invoiceDueDays.
  describe('create — dueDate за invoiceDueDays (§13)', () => {
    const CP = '44444444-4444-4444-8444-444444444444';
    const setup = () => {
      prisma.counterparty.findFirst.mockResolvedValue({ id: CP });
      prisma.invoice.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: INV_ID,
          number: 'INV-1',
          status: 'DRAFT',
          amount: data.amount,
          workOrderId: null,
          counterpartyId: CP,
          documentDate: data.documentDate,
          dueDate: data.dueDate,
          deletedAt: null,
          totalWithoutVat: 0,
          totalVat: 0,
          totalWithVat: data.amount,
          createdAt: new Date(),
          counterparty: { firstName: 'a', lastName: 'b', companyName: null },
          workOrder: null,
        }),
      );
    };

    it('коли dueDate не задано → documentDate + invoiceDueDays(7)', async () => {
      setup();
      await service.create(ORG, {
        counterpartyId: CP,
        amount: 100,
        documentDate: '2026-03-01',
      } as never);
      const arg = prisma.invoice.create.mock.calls[0][0].data;
      // 2026-03-01 + 7 днів = 2026-03-08 (Kyiv, DST-aware addDaysKyiv)
      expect((arg.dueDate as Date).toISOString().slice(0, 10)).toBe('2026-03-08');
      expect(settingsMock.getOrganisationSettings).toHaveBeenCalledWith(ORG);
    });

    it('явно заданий dueDate поважається (invoiceDueDays ігнорується)', async () => {
      setup();
      await service.create(ORG, {
        counterpartyId: CP,
        amount: 100,
        documentDate: '2026-03-01',
        dueDate: '2026-03-20',
      } as never);
      const arg = prisma.invoice.create.mock.calls[0][0].data;
      expect((arg.dueDate as Date).toISOString().slice(0, 10)).toBe('2026-03-20');
    });

    it('налаштування недоступні → fallback 7 днів (без падіння)', async () => {
      setup();
      settingsMock.getOrganisationSettings.mockRejectedValueOnce(new Error('db down'));
      await service.create(ORG, {
        counterpartyId: CP,
        amount: 100,
        documentDate: '2026-03-01',
      } as never);
      const arg = prisma.invoice.create.mock.calls[0][0].data;
      expect((arg.dueDate as Date).toISOString().slice(0, 10)).toBe('2026-03-08');
    });

    it('DST boundary: documentDate 2026-10-24 + 7д перетинає осінній перехід → 2026-10-31 (без стрибка)', async () => {
      // Kyiv осінній fallback = остання неділя жовтня (2026-10-25). addDaysKyiv рахує через
      // UTC-дні на date-only → зсув рівно 7 календарних днів, DST не з'їдає/не додає доби.
      setup();
      settingsMock.getOrganisationSettings.mockResolvedValueOnce({ invoiceDueDays: 7 });
      await service.create(ORG, {
        counterpartyId: CP,
        amount: 100,
        documentDate: '2026-10-24',
      } as never);
      const arg = prisma.invoice.create.mock.calls[0][0].data;
      expect((arg.dueDate as Date).toISOString().slice(0, 10)).toBe('2026-10-31');
    });

    it('DST boundary: documentDate 2026-03-28 + 7д перетинає весняний перехід → 2026-04-04', async () => {
      // Kyiv весняний spring-forward = остання неділя березня (2026-03-29).
      setup();
      settingsMock.getOrganisationSettings.mockResolvedValueOnce({ invoiceDueDays: 7 });
      await service.create(ORG, {
        counterpartyId: CP,
        amount: 100,
        documentDate: '2026-03-28',
      } as never);
      const arg = prisma.invoice.create.mock.calls[0][0].data;
      expect((arg.dueDate as Date).toISOString().slice(0, 10)).toBe('2026-04-04');
    });

    // guards: BR-INV-004
    it('invoiceDueDays=0 → dueDate === documentDate (термін оплати того ж дня)', async () => {
      setup();
      settingsMock.getOrganisationSettings.mockResolvedValueOnce({ invoiceDueDays: 0 });
      await service.create(ORG, {
        counterpartyId: CP,
        amount: 100,
        documentDate: '2026-03-01',
      } as never);
      const arg = prisma.invoice.create.mock.calls[0][0].data;
      expect((arg.dueDate as Date).toISOString().slice(0, 10)).toBe('2026-03-01');
    });

    it('негативний invoiceDueDays ігнорується (>= 0 guard) → fallback 7 днів', async () => {
      setup();
      settingsMock.getOrganisationSettings.mockResolvedValueOnce({ invoiceDueDays: -5 });
      await service.create(ORG, {
        counterpartyId: CP,
        amount: 100,
        documentDate: '2026-03-01',
      } as never);
      const arg = prisma.invoice.create.mock.calls[0][0].data;
      // raw < 0 → умова (Number.isFinite && raw >= 0) хибна → dueDays лишається 7.
      expect((arg.dueDate as Date).toISOString().slice(0, 10)).toBe('2026-03-08');
    });
  });
});
