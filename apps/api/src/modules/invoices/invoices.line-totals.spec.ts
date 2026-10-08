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
  let settings: InvoicesHarness['settings'];
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
    ({ service, prisma, settings } = await makeInvoicesHarness());
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

  // ─── BR-INV-017: ПДВ ручного рядка — за режимом організації ─────────────────
  //
  // Сума рядка = кількість × ціна. «ПДВ у ціні» — ПДВ ВИДІЛЯЄТЬСЯ з цієї суми (рядок не
  // дорожчає); інакше — нараховується зверху. Перевіряється те, що лягає в БД рядка.
  describe('ПДВ ручного рядка за режимом організації (BR-INV-017)', () => {
    const vat = (vatMode: 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE', vatRate: number) =>
      settings.getDefaultVatRate.mockResolvedValue({ vatMode, vatRate });
    const created = () => lines.create.mock.calls[0][0].data as Record<string, number>;
    const updated = () => lines.update.mock.calls[0][0].data as Record<string, number>;
    const add = (dto: Record<string, unknown>) =>
      service.addLine(ORG, INV_ID, { description: 'Діагностика', ...dto } as never);

    beforeEach(() => {
      lines.aggregate.mockResolvedValue({
        _sum: { priceWithoutVat: 0, vatAmount: 0, priceWithVat: 0 },
      });
    });

    // guards: BR-INV-017
    it('addLine, «ПДВ у ціні» 20%: 100 → без ПДВ 83.33, ПДВ 16.67, з ПДВ 100 (рядок не дорожчає)', async () => {
      vat('INCLUSIVE', 20);

      await add({ quantity: 1, unitPrice: 100 });

      expect(created()).toMatchObject({
        vatRate: 20,
        priceWithoutVat: 83.33,
        vatAmount: 16.67,
        priceWithVat: 100,
      });
    });

    // guards: BR-INV-017
    it('addLine, «ПДВ у ціні»: сума рядка = кількість × ціна (4 × 25 = 100), ПДВ виділено з неї', async () => {
      vat('INCLUSIVE', 20);

      await add({ quantity: 4, unitPrice: 25 });

      expect(created()).toMatchObject({
        quantity: 4,
        unitPrice: 25,
        priceWithoutVat: 83.33,
        vatAmount: 16.67,
        priceWithVat: 100,
      });
    });

    // guards: BR-INV-017
    it('addLine, «ПДВ у ціні» з явною ставкою 7%: ПДВ виділяється з суми за ставкою запиту', async () => {
      vat('INCLUSIVE', 20);

      await add({ quantity: 1, unitPrice: 107, vatRate: 7 });

      expect(created()).toMatchObject({
        vatRate: 7,
        priceWithoutVat: 100,
        vatAmount: 7,
        priceWithVat: 107,
      });
    });

    // guards: BR-INV-017
    it('addLine, «ПДВ зверху» 20%: 100 → без ПДВ 100, ПДВ 20, з ПДВ 120', async () => {
      vat('EXCLUSIVE', 20);

      await add({ quantity: 1, unitPrice: 100 });

      expect(created()).toMatchObject({
        vatRate: 20,
        priceWithoutVat: 100,
        vatAmount: 20,
        priceWithVat: 120,
      });
    });

    // guards: BR-INV-017
    it('addLine, без ПДВ в організації і без ставки в запиті → ставка 0, ПДВ 0', async () => {
      vat('NONE', 0);

      await add({ quantity: 1, unitPrice: 100 });

      expect(created()).toMatchObject({
        vatRate: 0,
        priceWithoutVat: 100,
        vatAmount: 0,
        priceWithVat: 100,
      });
    });

    // guards: BR-INV-017
    it('addLine, без ПДВ в організації, але ставку 20% передано явно → нараховується зверху', async () => {
      vat('NONE', 0);

      await add({ quantity: 1, unitPrice: 100, vatRate: 20 });

      expect(created()).toMatchObject({
        vatRate: 20,
        priceWithoutVat: 100,
        vatAmount: 20,
        priceWithVat: 120,
      });
    });

    // guards: BR-INV-017
    it('updateLine, «ПДВ у ціні» 20%: рядок 1 × 100 → 83.33 / 16.67 / 100', async () => {
      vat('INCLUSIVE', 20);

      await service.updateLine(ORG, INV_ID, LINE_ID, { quantity: 1, unitPrice: 100 } as never);

      expect(updated()).toMatchObject({
        quantity: 1,
        unitPrice: 100,
        vatRate: 20, // ставка наявного рядка, у запиті її не міняли
        priceWithoutVat: 83.33,
        vatAmount: 16.67,
        priceWithVat: 100,
      });
    });

    // guards: BR-INV-017
    it('updateLine, «ПДВ зверху» 20%: рядок 1 × 100 → 100 / 20 / 120', async () => {
      vat('EXCLUSIVE', 20);

      await service.updateLine(ORG, INV_ID, LINE_ID, { quantity: 1, unitPrice: 100 } as never);

      expect(updated()).toMatchObject({
        priceWithoutVat: 100,
        vatAmount: 20,
        priceWithVat: 120,
      });
    });

    // guards: BR-INV-017
    it('тотожність рядка в обох режимах на «незручній» сумі 33.33: без ПДВ + ПДВ = з ПДВ', async () => {
      vat('INCLUSIVE', 20);
      await add({ quantity: 1, unitPrice: 33.33 });
      const incl = created();
      expect(incl.priceWithVat).toBe(33.33);
      expect(Math.round((incl.priceWithoutVat + incl.vatAmount) * 100)).toBe(3333);

      lines.create.mockClear();
      vat('EXCLUSIVE', 20);
      await add({ quantity: 1, unitPrice: 33.33 });
      const excl = created();
      expect(excl.priceWithoutVat).toBe(33.33);
      expect(excl.vatAmount).toBe(6.67);
      expect(excl.priceWithVat).toBe(40);
    });
  });
});
