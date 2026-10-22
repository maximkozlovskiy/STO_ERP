/**
 * Одиниця рядка рахунку — та сама, що в наряді (Bug #868).
 *
 * Наживо: запчастина в наряді «1 Пак × 450» (коефіцієнт 10), а рахунок із того ж наряду —
 * «1 шт × 450». Рядок рахунку не отримував `unitOfMeasureId`, картка й друк брали базову одиницю
 * товару, а `addLine` шукав GoodUoM за власним id, хоча `InvoiceLine.unitOfMeasureId` — FK на
 * `UnitOfMeasure` (як у рядку наряду), тож рядок з альтернативною одиницею не додавався зовсім.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeInvoicesHarness,
  ORG,
  WO_ID,
  INV_ID,
  type InvoicesHarness,
} from './invoices.spec-fixture';
import { buildInvoiceLinesFromWorkOrder } from './work-order-invoice-lines';

const GOOD = 'good-1';
const PAK = 'uom-pak';
const NONE = { vatMode: 'NONE' as const, vatRate: 0 };

/** Рядок рахунку в одиниці «Пак»; базова одиниця товару — «шт». */
const pakLine = (over: Record<string, unknown> = {}) => ({
  id: 'line-1',
  invoiceId: INV_ID,
  goodId: GOOD,
  workId: null,
  description: 'Фільтр',
  quantity: 1,
  unitPrice: 450,
  vatRate: 0,
  priceWithoutVat: 450,
  vatAmount: 0,
  priceWithVat: 450,
  sortOrder: 0,
  unitOfMeasureId: PAK,
  createdAt: new Date('2026-10-22T00:00:00Z'),
  unitOfMeasure: { shortName: 'Пак' },
  good: { unit: 'шт', unitOfMeasure: { shortName: 'шт', coefficient: 1 } },
  ...over,
});

const invoiceRow = (lines: unknown[]) => ({
  id: INV_ID,
  orgId: ORG,
  number: 'INV-2026-0001',
  status: 'DRAFT',
  counterpartyId: 'c-1',
  workOrderId: WO_ID,
  amount: 450,
  totalWithoutVat: 450,
  totalVat: 0,
  totalWithVat: 450,
  invoiceType: 'STANDARD',
  notes: null,
  dueDate: null,
  documentDate: new Date('2026-10-22T00:00:00Z'),
  createdAt: new Date('2026-10-22T00:00:00Z'),
  updatedAt: new Date('2026-10-22T00:00:00Z'),
  lines,
  payments: [],
});

describe('Рахунок — одиниця рядка як у наряді (Bug #868)', () => {
  let h: InvoicesHarness;
  let goodUoM: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  let prismaExtra: Record<string, unknown>;

  beforeEach(async () => {
    h = await makeInvoicesHarness();
    goodUoM = {
      findMany: vi.fn().mockResolvedValue([
        {
          goodId: GOOD,
          unitOfMeasureId: PAK,
          coefficient: 10,
          unitOfMeasure: { shortName: 'Пак' },
        },
      ]),
      findFirst: vi
        .fn()
        .mockResolvedValue({ coefficient: 10, unitOfMeasure: { shortName: 'Пак' } }),
    };
    // Харнес не має цих моделей — доповнюємо той самий об'єкт, що отримав сервіс.
    prismaExtra = h.prisma as unknown as Record<string, unknown>;
    prismaExtra.goodUoM = goodUoM;
    prismaExtra.good = { findFirst: vi.fn().mockResolvedValue({ id: GOOD }) };
    prismaExtra.work = { findFirst: vi.fn() };
    (h.prisma.invoiceLine as Record<string, unknown>).create = vi.fn().mockResolvedValue(pakLine());
    (h.prisma.invoiceLine as Record<string, unknown>).aggregate = vi.fn().mockResolvedValue({
      _sum: { priceWithoutVat: 450, vatAmount: 0, priceWithVat: 450 },
    });
    h.prisma.invoice.update.mockResolvedValue({});
    h.prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
  });

  it('рядок наряду переносить у рахунок свою одиницю (чиста функція)', () => {
    const [part] = buildInvoiceLinesFromWorkOrder(
      {
        totalNet: 450,
        totalAmount: 450,
        lines: [],
        parts: [
          { goodId: GOOD, name: 'Фільтр', quantity: 1, unitPrice: 450, unitOfMeasureId: PAK },
        ],
      },
      NONE,
    );
    expect(part).toMatchObject({ goodId: GOOD, quantity: 1, unitPrice: 450, unitOfMeasureId: PAK });
  });

  it('оновлення рахунку з наряду: рядок запчастини записується з одиницею наряду', async () => {
    h.prisma.workOrder.findFirst.mockResolvedValue({
      id: WO_ID,
      orgId: ORG,
      status: 'COMPLETED',
      counterpartyId: 'c-1',
      totalNet: 450,
      totalAmount: 450,
      lines: [],
      parts: [
        { goodId: GOOD, quantity: 1, price: 450, unitOfMeasureId: PAK, good: { name: 'Фільтр' } },
      ],
    });
    h.prisma.invoice.findFirst
      .mockResolvedValueOnce({ id: INV_ID, orgId: ORG, status: 'DRAFT', workOrderId: WO_ID })
      .mockResolvedValueOnce({ status: 'DRAFT' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(invoiceRow([pakLine()]));

    await h.service.refreshFromWorkOrder(ORG, WO_ID);

    // Наряд читається разом з одиницею рядка запчастини.
    const woSelect = h.prisma.workOrder.findFirst.mock.calls
      .map(c => c[0] as { select?: { parts?: { select?: Record<string, unknown> } } })
      .find(a => a.select?.parts);
    expect(woSelect!.select!.parts!.select).toHaveProperty('unitOfMeasureId', true);
    const data = h.prisma.invoiceLine.createMany.mock.calls[0]![0].data as Record<
      string,
      unknown
    >[];
    expect(data[0]).toMatchObject({ goodId: GOOD, quantity: 1, unitOfMeasureId: PAK });
  });

  it('картка рахунку: «Пак» з коефіцієнтом товару, а не базова «шт»', async () => {
    h.prisma.invoice.findFirst.mockResolvedValue(invoiceRow([pakLine()]));
    const dto = await h.service.findOne(ORG, INV_ID);
    expect(dto.lines![0]).toMatchObject({
      unitOfMeasureId: PAK,
      unitShortName: 'Пак',
      coefficient: 10,
    });
    expect(goodUoM.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orgId: ORG, unitOfMeasureId: { in: [PAK] } }),
      }),
    );
  });

  it('рядок без одиниці — базова одиниця товару, без запиту одиниць', async () => {
    h.prisma.invoice.findFirst.mockResolvedValue(
      invoiceRow([pakLine({ unitOfMeasureId: null, unitOfMeasure: null })]),
    );
    const dto = await h.service.findOne(ORG, INV_ID);
    expect(dto.lines![0]).toMatchObject({ unitShortName: 'шт', coefficient: 1 });
    expect(goodUoM.findMany).not.toHaveBeenCalled();
  });

  it('addLine приймає UnitOfMeasure.id (як наряд): пара шукається за unitOfMeasureId товару', async () => {
    h.prisma.invoice.findFirst.mockResolvedValue({ id: INV_ID, orgId: ORG, status: 'DRAFT' });
    const res = await h.service.addLine(ORG, INV_ID, {
      goodId: GOOD,
      description: 'Фільтр',
      quantity: 1,
      unitPrice: 450,
      unitOfMeasureId: PAK,
    } as never);
    expect(goodUoM.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { unitOfMeasureId: PAK, goodId: GOOD, orgId: ORG } }),
    );
    const create = (h.prisma.invoiceLine as unknown as { create: ReturnType<typeof vi.fn> }).create;
    expect(create.mock.calls[0]![0].data).toMatchObject({ unitOfMeasureId: PAK });
    expect(res).toMatchObject({ unitShortName: 'Пак', coefficient: 10 });
  });

  it('друкований рахунок: одиниця рядка «Пак»', async () => {
    h.pdf.generateInvoicePdf.mockResolvedValue(Buffer.from('%PDF'));
    h.prisma.invoice.findFirst.mockResolvedValue({
      ...invoiceRow([pakLine()]),
      counterparty: {
        firstName: null,
        lastName: null,
        companyName: 'ТОВ Бета',
        phone: null,
        edrpou: null,
      },
    });
    await h.service.generatePdf(ORG, INV_ID);
    const arg = h.pdf.generateInvoicePdf.mock.calls[0]![0] as { lines: { unit: string }[] };
    expect(arg.lines[0]!.unit).toBe('Пак');
  });
});
