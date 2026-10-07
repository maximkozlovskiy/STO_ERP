/**
 * InvoicesService — підсумки рахунку рахує БЕКЕНД (BR-INV-008)
 *
 * Аспект: після будь-якої зміни рядка (`addLine` / `updateLine` / `removeLine`) сервіс
 * викликає `recalcTotals()`: один `invoiceLine.aggregate(_sum)` → `totalWithoutVat` /
 * `totalVat` / `totalWithVat`, і `amount = totalWithVat`. Фронт цих сум не рахує —
 * `calcVatTotals()` з `apps/web/src/lib/utils.ts` сторінка рахунку не викликає (єдиний
 * споживач — модалка наряду), вона показує те, що повернув API.
 *
 * Сетап — `makeInvoicesHarness()` з `./invoices.spec-fixture`. Харнес не має моків
 * `invoiceLine.create/update/findFirst/aggregate` (іншим аспектам вони не потрібні), тому
 * вони доклеюються ТУТ, у beforeEach, а не у спільну фікстуру.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { makeInvoicesHarness, ORG, INV_ID, type InvoicesHarness } from './invoices.spec-fixture';

type Fn = ReturnType<typeof vi.fn>;

describe('InvoicesService — line-totals (recalcTotals на бекенді)', () => {
  let service: InvoicesHarness['service'];
  let prisma: InvoicesHarness['prisma'];
  let lines: { create: Fn; update: Fn; findFirst: Fn; aggregate: Fn; deleteMany: Fn };

  const LINE_ID = '77777777-7777-4777-8777-777777777777';
  const DOC_DATE = new Date('2026-03-01');

  // Рядок, який «повертає БД» після create/update — toLineDto читає з нього лише поля DTO.
  const dbLine = {
    id: LINE_ID,
    invoiceId: INV_ID,
    goodId: null,
    workId: null,
    description: 'Діагностика',
    quantity: 2,
    unitPrice: 500,
    vatRate: 20,
    priceWithoutVat: 1000,
    vatAmount: 200,
    priceWithVat: 1200,
    sortOrder: 0,
    unitOfMeasureId: null,
    createdAt: new Date('2026-03-01T10:00:00Z'),
    good: null,
  };

  beforeEach(async () => {
    ({ service, prisma } = await makeInvoicesHarness());
    lines = prisma.invoiceLine as unknown as typeof lines;
    lines.create = vi.fn().mockResolvedValue(dbLine);
    lines.update = vi.fn().mockResolvedValue(dbLine);
    lines.findFirst = vi.fn().mockResolvedValue(dbLine);
    lines.aggregate = vi.fn();
    lines.deleteMany.mockResolvedValue({ count: 1 });
    // Перший findFirst — tenant-guard рядкового методу (потрібен status), другий — recalcTotals
    // (валюта + дата документа). Один об'єкт задовольняє обидва виклики.
    prisma.invoice.findFirst.mockResolvedValue({
      id: INV_ID,
      status: 'DRAFT',
      currencyId: null,
      documentDate: DOC_DATE,
    });
    prisma.invoice.update.mockResolvedValue({});
  });

  // guards: BR-INV-008
  it('addLine → підсумки рахунку = Σ рядків з БД (aggregate), amount = totalWithVat', async () => {
    // У рахунку вже був рядок: сума по ВСІХ рядках (1500 / 300 / 1800) ≠ сумі доданого
    // (1000 / 200 / 1200) — тож підсумок не можна взяти з щойно доданого рядка.
    lines.aggregate.mockResolvedValue({
      _sum: { priceWithoutVat: 1500, vatAmount: 300, priceWithVat: 1800 },
    });

    await service.addLine(ORG, INV_ID, {
      description: 'Діагностика',
      quantity: 2,
      unitPrice: 500,
      vatRate: 20,
    } as never);

    expect(lines.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { invoiceId: INV_ID, orgId: ORG } }),
    );
    expect(prisma.invoice.update).toHaveBeenCalledTimes(1);
    expect(prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INV_ID, orgId: ORG },
        data: expect.objectContaining({
          totalWithoutVat: 1500,
          totalVat: 300,
          totalWithVat: 1800,
          amount: 1800,
        }),
      }),
    );
  });

  // guards: BR-INV-008
  it('updateLine → підсумки перераховано з aggregate, amount = totalWithVat (не сума без ПДВ)', async () => {
    lines.aggregate.mockResolvedValue({
      _sum: { priceWithoutVat: 3000, vatAmount: 600, priceWithVat: 3600 },
    });

    await service.updateLine(ORG, INV_ID, LINE_ID, { quantity: 6 } as never);

    expect(prisma.invoice.update).toHaveBeenCalledTimes(1);
    expect(prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalWithoutVat: 3000,
          totalVat: 600,
          totalWithVat: 3600,
          amount: 3600,
        }),
      }),
    );
  });

  // guards: BR-INV-008
  it('removeLine останнього рядка → aggregate дає null → усі підсумки й amount = 0', async () => {
    lines.aggregate.mockResolvedValue({
      _sum: { priceWithoutVat: null, vatAmount: null, priceWithVat: null },
    });

    await service.removeLine(ORG, INV_ID, LINE_ID);

    expect(lines.deleteMany).toHaveBeenCalledWith({
      where: { id: LINE_ID, invoiceId: INV_ID, orgId: ORG },
    });
    expect(prisma.invoice.update).toHaveBeenCalledTimes(1);
    expect(prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalWithoutVat: 0,
          totalVat: 0,
          totalWithVat: 0,
          amount: 0,
        }),
      }),
    );
  });
});
