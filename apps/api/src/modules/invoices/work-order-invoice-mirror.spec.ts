/**
 * Рахунок наряду — дзеркало наряду (рішення власника 2026-10-15).
 *
 *   BR-INV-018 — активний рахунок наряду: `paidAmount = min(сплачено наряду, сума рахунку)`, статус
 *                за сплаченим; DRAFT показує сплачене, але лишається DRAFT; CANCELLED не чіпається;
 *                на DRAFT → SENT статус береться за сплаченим; перерахунок суми — теж через дзеркало;
 *   BR-INV-020 — рахунок з наряду одразу переносить сплачене; створюється й для «Оплачено».
 *
 * Наряд, рахунок і рядки — таблиці в пам'яті (`memoryTable`): дзеркало й CAS застосовують `where`
 * по-справжньому.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { InvoiceStatus } from '@prisma/client';
import { mirroredInvoiceStatus, syncWorkOrderInvoicePaid } from './work-order-invoice-mirror';
import { InvoicesService } from './invoices.service';
import { exchangeRatesMock } from './invoices.spec-fixture';
import { memoryTable, type MemRow } from '../cash/cash.spec-fixture';

const ORG = 'org-1';
const WO = '11111111-1111-4111-8111-111111111111';
const INV = '22222222-2222-4222-8222-222222222222';
const CP = '33333333-3333-4333-8333-333333333333';

function tables(wo: MemRow, invoices: MemRow[]) {
  return {
    workOrder: memoryTable([{ id: WO, orgId: ORG, deletedAt: null, ...wo }]),
    invoice: memoryTable(
      invoices.map(i => ({
        id: INV,
        orgId: ORG,
        workOrderId: WO,
        counterpartyId: CP,
        deletedAt: null,
        ...i,
      })),
    ),
    // BR-AUT-060: зміна статусу рахунку дзеркалом — подія outbox у тій самій транзакції.
    domainEvent: memoryTable([]),
  };
}

describe('mirroredInvoiceStatus — статус рахунку наряду за сплаченим (BR-INV-018)', () => {
  // guards: BR-INV-018
  it.each([
    ['SENT', 1000, 1000, 'PAID'],
    ['SENT', 1000, 400, 'PARTIALLY_PAID'],
    ['SENT', 1000, 0, 'SENT'],
    ['PARTIALLY_PAID', 1000, 0, 'SENT'],
    ['PARTIALLY_PAID', 1000, 1000, 'PAID'],
    ['PAID', 1000, 600, 'PARTIALLY_PAID'],
    ['PAID', 1000, 0, 'SENT'],
    ['OVERDUE', 1000, 0, 'OVERDUE'],
    ['OVERDUE', 1000, 300, 'PARTIALLY_PAID'],
    ['OVERDUE', 1000, 1000, 'PAID'],
    ['DRAFT', 1000, 1000, 'DRAFT'],
    ['CANCELLED', 1000, 1000, 'CANCELLED'],
  ])('%s, сума %d, сплачено %d → %s', (status, amount, paid, expected) => {
    expect(mirroredInvoiceStatus(status as InvoiceStatus, amount, paid)).toBe(expected);
  });

  // guards: BR-INV-018
  it('рахунок на 0 при сплаченому 0 — не «Оплачено»', () => {
    expect(mirroredInvoiceStatus(InvoiceStatus.SENT, 0, 0)).toBe('SENT');
  });
});

// Рішення власника 2026-10-30 (TECH-DEBT (б) №44): прострочений рахунок наряду, що перестав бути
// сплаченим повністю (сторно) чи сплачений частково, — «Прострочено» одразу.
describe('syncWorkOrderInvoicePaid — прострочений рахунок наряду (BR-INV-025)', () => {
  const PAST = new Date('2020-01-10T00:00:00.000Z');
  const FUTURE = new Date('2999-01-10T00:00:00.000Z');

  // guards: BR-INV-025
  it('сторно повної оплати простроченого рахунку → «Прострочено», а не «Виставлено»', async () => {
    const t = tables({ paidAmount: 0 }, [
      { status: 'PAID', amount: 1000, paidAmount: 1000, dueDate: PAST },
    ]);

    await syncWorkOrderInvoicePaid(t as never, ORG, WO, 'emp-1');

    expect(t.invoice.rows[0]).toMatchObject({ paidAmount: 0, status: 'OVERDUE' });
    expect(t.domainEvent.rows).toEqual([
      expect.objectContaining({ fromStatus: 'PAID', toStatus: 'OVERDUE' }),
    ]);
    // Термін читається тим самим запитом, що й суми рахунку (без нього правило сліпе).
    const readArgs = t.invoice.findFirst.mock.calls[0]![0] as { select?: Record<string, boolean> };
    expect(readArgs.select).toMatchObject({ dueDate: true });
  });

  // guards: BR-INV-025
  it('часткова оплата простроченого рахунку наряду → лишається «Прострочено»', async () => {
    const t = tables({ paidAmount: 300 }, [
      { status: 'OVERDUE', amount: 1000, paidAmount: 0, dueDate: PAST },
    ]);

    await syncWorkOrderInvoicePaid(t as never, ORG, WO);

    expect(t.invoice.rows[0]).toMatchObject({ paidAmount: 300, status: 'OVERDUE' });
  });

  // guards: BR-INV-025
  it('термін ще не минув → «Частково оплачено», як раніше', async () => {
    const t = tables({ paidAmount: 300 }, [
      { status: 'SENT', amount: 1000, paidAmount: 0, dueDate: FUTURE },
    ]);

    await syncWorkOrderInvoicePaid(t as never, ORG, WO);

    expect(t.invoice.rows[0]).toMatchObject({ paidAmount: 300, status: 'PARTIALLY_PAID' });
  });
});

describe('syncWorkOrderInvoicePaid — дзеркало сплаченого наряду (BR-INV-018)', () => {
  // guards: BR-AUT-060
  it('зміна статусу рахунку дзеркалом — подія з попереднім статусом і ініціатором', async () => {
    const t = tables({ paidAmount: 400 }, [{ status: 'SENT', amount: 1000, paidAmount: 0 }]);

    await syncWorkOrderInvoicePaid(t as never, ORG, WO, 'emp-1');

    expect(t.domainEvent.rows).toEqual([
      expect.objectContaining({
        orgId: ORG,
        documentType: 'INVOICE',
        documentId: INV,
        kind: 'STATUS_CHANGED',
        fromStatus: 'SENT',
        toStatus: 'PARTIALLY_PAID',
        actorId: 'emp-1',
      }),
    ]);
  });

  // guards: BR-AUT-060
  it('змінилось лише «сплачено», статус той самий → події немає', async () => {
    const t = tables({ paidAmount: 500 }, [
      { status: 'PARTIALLY_PAID', amount: 1000, paidAmount: 400 },
    ]);

    await syncWorkOrderInvoicePaid(t as never, ORG, WO);

    expect(t.invoice.rows[0]).toMatchObject({ paidAmount: 500, status: 'PARTIALLY_PAID' });
    expect(t.domainEvent.rows).toEqual([]);
  });

  // guards: BR-INV-018
  it('сплачено наряду 400 з 1000 → рахунок 400, «Частково оплачено»', async () => {
    const t = tables({ paidAmount: 400 }, [{ status: 'SENT', amount: 1000, paidAmount: 0 }]);

    await syncWorkOrderInvoicePaid(t as never, ORG, WO);

    expect(t.invoice.rows[0]).toMatchObject({ paidAmount: 400, status: 'PARTIALLY_PAID' });
  });

  // guards: BR-INV-018
  it('сплачено наряду більше за суму рахунку → сплачене рахунку = сума рахунку, «Оплачено»', async () => {
    const t = tables({ paidAmount: 1200 }, [{ status: 'SENT', amount: 1000, paidAmount: 0 }]);

    await syncWorkOrderInvoicePaid(t as never, ORG, WO);

    expect(t.invoice.rows[0]).toMatchObject({ paidAmount: 1000, status: 'PAID' });
  });

  // guards: BR-INV-018
  it('чернетка показує сплачене, але лишається DRAFT', async () => {
    const t = tables({ paidAmount: 300 }, [{ status: 'DRAFT', amount: 1000, paidAmount: 0 }]);

    await syncWorkOrderInvoicePaid(t as never, ORG, WO);

    expect(t.invoice.rows[0]).toMatchObject({ paidAmount: 300, status: 'DRAFT' });
  });

  // guards: BR-INV-018
  it('скасований рахунок не чіпається (не активний)', async () => {
    const t = tables({ paidAmount: 300 }, [{ status: 'CANCELLED', amount: 1000, paidAmount: 0 }]);

    await syncWorkOrderInvoicePaid(t as never, ORG, WO);

    expect(t.invoice.rows[0]).toMatchObject({ paidAmount: 0, status: 'CANCELLED' });
    expect(t.invoice.updateMany).not.toHaveBeenCalled();
  });

  // guards: BR-INV-018
  it('рахунок уже збігається з нарядом → жодного запису', async () => {
    const t = tables({ paidAmount: 400 }, [
      { status: 'PARTIALLY_PAID', amount: 1000, paidAmount: 400 },
    ]);

    await syncWorkOrderInvoicePaid(t as never, ORG, WO);

    expect(t.invoice.updateMany).not.toHaveBeenCalled();
  });

  // guards: BR-INV-018
  it('рахунку наряду немає → нічого не робить', async () => {
    const t = tables({ paidAmount: 400 }, []);

    await expect(syncWorkOrderInvoicePaid(t as never, ORG, WO)).resolves.toBeUndefined();
  });

  // Рахунок змінили між читанням і записом (паралельна відправка / перерахунок): запис — CAS за
  // прочитаними статусом, сумою і сплаченим; не пройшов → перечитати й порахувати заново.
  // guards: BR-INV-018
  it('CAS програв один раз → перечитує рахунок і пише за свіжим станом', async () => {
    const t = tables({ paidAmount: 500 }, [{ status: 'DRAFT', amount: 1000, paidAmount: 0 }]);
    const readInvoice = t.invoice.findFirst.getMockImplementation()!;
    t.invoice.findFirst.mockImplementationOnce((args?: { where?: unknown }) =>
      readInvoice(args).then(r => {
        const snapshot = { ...r };
        // Між читанням і записом рахунок відправили (DRAFT → SENT).
        t.invoice.rows[0]!.status = 'SENT';
        return snapshot;
      }),
    );

    await syncWorkOrderInvoicePaid(t as never, ORG, WO);

    expect(t.invoice.updateMany).toHaveBeenCalledTimes(2);
    expect(t.invoice.updateMany.mock.calls[0]![0].where).toMatchObject({
      id: INV,
      status: 'DRAFT',
      amount: 1000,
      paidAmount: 0,
    });
    expect(t.invoice.rows[0]).toMatchObject({ paidAmount: 500, status: 'PARTIALLY_PAID' });
  });

  // guards: BR-INV-018
  it('рахунок змінюють безперервно → після кількох спроб 400 «повторіть», не нескінченний цикл', async () => {
    const t = tables({ paidAmount: 500 }, [{ status: 'SENT', amount: 1000, paidAmount: 0 }]);
    t.invoice.updateMany.mockResolvedValue({ count: 0 });

    await expect(syncWorkOrderInvoicePaid(t as never, ORG, WO)).rejects.toThrow(
      BadRequestException,
    );
    expect(t.invoice.updateMany).toHaveBeenCalledTimes(3);
  });
});

// ── InvoicesService: створення, відправка й перерахунок рахунку наряду ──────────────────────

function makeService(opts: { wo: MemRow; invoices?: MemRow[]; lines?: MemRow[] }) {
  const t = tables(opts.wo, opts.invoices ?? []);
  const invoiceDefaults = () => ({
    orgId: ORG,
    invoiceType: 'STANDARD',
    notes: null,
    paidAmount: 0,
    deletedAt: null,
    totalWithoutVat: 0,
    totalVat: 0,
    totalWithVat: 0,
    createdAt: new Date('2026-10-15'),
    updatedAt: new Date('2026-10-15'),
    counterparty: { firstName: null, lastName: null, companyName: 'ТОВ' },
    workOrder: { number: 'НРД-1' },
  });
  const lineRows = opts.lines ?? [];
  // `_count.lines` (BR-INV-023) рахується з таблиці рядків за invoiceId, а не задається заготовкою.
  const invoice = memoryTable(
    t.invoice.rows.map(r => ({ ...invoiceDefaults(), ...r })),
    invoiceDefaults,
    { _count: row => ({ lines: lineRows.filter(l => l.invoiceId === row.id).length }) },
  );
  const invoiceLine = {
    ...memoryTable(lineRows),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const prisma: Record<string, unknown> = {
    workOrder: t.workOrder,
    domainEvent: t.domainEvent,
    invoice,
    invoiceLine,
    good: memoryTable([]),
    work: memoryTable([]),
    goodUoM: memoryTable([]),
  };
  prisma.$transaction = vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(prisma));
  const settings = {
    getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }),
    getTaxRates: vi.fn().mockResolvedValue([]),
    getOrganisationSettings: vi.fn().mockResolvedValue({ invoiceDueDays: 7 }),
  };
  const service = new InvoicesService(
    prisma as never,
    { next: vi.fn().mockResolvedValue('INV-1') } as never,
    null as never, // pdf
    { createTransaction: vi.fn().mockResolvedValue(undefined) } as never,
    settings as never,
    { record: vi.fn().mockResolvedValue(undefined) } as never,
    exchangeRatesMock().useValue as never,
    null as never, // orgPrintInfo
  );
  return { service, workOrder: t.workOrder, invoice };
}

// Наряд на 1000 з однією роботою — рядки сходяться із сумою (BR-INV-002).
const WO_1000 = {
  counterpartyId: CP,
  currencyId: null,
  totalNet: 1000,
  totalAmount: 1000,
  lines: [{ workId: 'w-1', price: 1000, normoHours: 1, actualHours: null, work: { name: 'Р' } }],
  parts: [],
};

// Рядок рахунку наряду (BR-INV-023: без рядків рахунок не виставляється).
const LINE_1000 = {
  id: 'line-1',
  orgId: ORG,
  invoiceId: INV,
  description: 'Р',
  priceWithVat: 1000,
};

describe('InvoicesService — рахунок наряду переносить сплачене (BR-INV-020, BR-INV-018)', () => {
  // guards: BR-INV-020
  it('рахунок для наряду «Оплачено» створюється: чернетка зі сплаченим = сума', async () => {
    const h = makeService({ wo: { ...WO_1000, status: 'PAID', paidAmount: 1000 } });

    const dto = await h.service.createFromWorkOrder(ORG, WO);

    expect(dto.status).toBe('DRAFT');
    expect(dto.paidAmount).toBe(1000);
    expect(h.invoice.rows[0]).toMatchObject({ status: 'DRAFT', amount: 1000, paidAmount: 1000 });
  });

  // guards: BR-INV-020
  it('рахунок для наряду з авансом: сплачене наряду одразу в рахунку', async () => {
    const h = makeService({ wo: { ...WO_1000, status: 'COMPLETED', paidAmount: 250 } });

    const dto = await h.service.createFromWorkOrder(ORG, WO);

    expect(dto.paidAmount).toBe(250);
  });

  // Рядок наряду — перший запис транзакції: оплата, що прийшла під час створення, чекає на коміт
  // і потрапляє в дзеркало нового рахунку (порядок блокувань «наряд → рахунок», як в оплаті).
  // guards: BR-INV-020
  it('рядок наряду блокується ПЕРШИМ записом — умовою статусу, що приймає рахунок', async () => {
    const h = makeService({ wo: { ...WO_1000, status: 'PAID', paidAmount: 1000 } });

    await h.service.createFromWorkOrder(ORG, WO);

    const lock = h.workOrder.updateMany.mock.calls[0]![0] as {
      where: { status: { in: string[] } };
    };
    expect(lock.where.status.in).toEqual(['COMPLETED', 'INVOICED', 'PAID']);
    expect(h.workOrder.updateMany.mock.invocationCallOrder[0]!).toBeLessThan(
      h.invoice.create.mock.invocationCallOrder[0]!,
    );
  });

  // guards: BR-INV-020
  it.each([['IN_PROGRESS'], ['ARCHIVED'], ['CANCELLED']])(
    'наряд у %s → 400, рахунок не створюється',
    async status => {
      const h = makeService({ wo: { ...WO_1000, status, paidAmount: 0 } });

      await expect(h.service.createFromWorkOrder(ORG, WO)).rejects.toThrow(
        'Рахунок можна виставити лише для завершеного наряду',
      );
      expect(h.invoice.rows).toHaveLength(0);
    },
  );

  // guards: BR-INV-018
  it.each([
    [1000, 'PAID'],
    [400, 'PARTIALLY_PAID'],
    [0, 'SENT'],
  ])('чернетка → «Виставлено», наряд сплачено %d з 1000 → статус %s', async (paid, expected) => {
    const h = makeService({
      wo: { ...WO_1000, status: 'INVOICED', paidAmount: paid },
      invoices: [{ status: 'DRAFT', amount: 1000, paidAmount: paid, currencyId: null }],
      lines: [LINE_1000],
    });

    const dto = await h.service.transition(ORG, INV, 'SENT' as never, 'u');

    expect(dto.status).toBe(expected);
    expect(h.invoice.rows[0]).toMatchObject({ status: expected, paidAmount: paid });
  });

  // Лічильник — за рядками САМЕ цього рахунку: рядок іншого рахунку виставлення не відкриває.
  // guards: BR-INV-023
  it('чернетка рахунку наряду без власних рядків → 400, лишається DRAFT', async () => {
    const h = makeService({
      wo: { ...WO_1000, status: 'INVOICED', paidAmount: 0 },
      invoices: [{ status: 'DRAFT', amount: 1000, paidAmount: 0, currencyId: null }],
      lines: [{ ...LINE_1000, id: 'line-other', invoiceId: 'other-invoice' }],
    });

    await expect(h.service.transition(ORG, INV, 'SENT' as never, 'u')).rejects.toThrow(
      'Рахунок без рядків не можна виставити',
    );
    expect(h.invoice.rows[0]).toMatchObject({ status: 'DRAFT' });
    expect(h.invoice.updateMany).not.toHaveBeenCalled();
  });

  // guards: BR-INV-018
  it('рядок чернетки рахунку наряду змінив суму (300 при сплаченому наряду 1000) → сплачене рахунку 300', async () => {
    const h = makeService({
      wo: { ...WO_1000, status: 'INVOICED', paidAmount: 1000 },
      invoices: [{ status: 'DRAFT', amount: 1000, paidAmount: 1000, currencyId: null }],
    });

    await h.service.addLine(ORG, INV, { description: 'Знижка', quantity: 1, unitPrice: 300 });

    expect(h.invoice.rows[0]).toMatchObject({ amount: 300, paidAmount: 300, status: 'DRAFT' });
  });

  // guards: BR-INV-018
  it('ручна зміна суми чернетки рахунку наряду → сплачене = min(сплачено наряду, сума)', async () => {
    const h = makeService({
      wo: { ...WO_1000, status: 'INVOICED', paidAmount: 600 },
      invoices: [{ status: 'DRAFT', amount: 1000, paidAmount: 600, currencyId: null }],
    });

    const dto = await h.service.update(ORG, INV, { amount: 500 });

    expect(dto.paidAmount).toBe(500);
    expect(h.invoice.rows[0]).toMatchObject({ amount: 500, paidAmount: 500 });
  });
});
