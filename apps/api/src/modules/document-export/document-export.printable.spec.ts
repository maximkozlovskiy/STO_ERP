/**
 * Мапери друкованих документів (BR-INV-028, BR-PO-016, BR-SDOC-009, BR-SRET-014): що потрапляє на
 * бланк — назва, номер, дата, сторони, реквізити, рядки в порядку картки з одиницею рядка, підсумки,
 * примітка, ім'я файла; видалений документ — з позначкою, чужий — 404.
 *
 * Prisma-двійник виконує `where` / `select` / `orderBy` (`document-export.spec-fixture.ts`), рядки в
 * сховищі навмисно перемішані. Мутації (2026-11-05): прибрати `orderBy` з мапера замовлення →
 * падає «рядки в порядку картки»; прибрати `orgId` з `where` рахунку → падає «чужа організація».
 */
import { NotFoundException } from '@nestjs/common';
import { describe, it, expect } from 'vitest';
import { loadInvoicePrintable } from './invoice-printable';
import { loadPurchaseOrderPrintable } from './purchase-order-printable';
import { loadStockDocumentPrintable } from './stock-document-printable';
import { loadSupplierReturnPrintable } from './supplier-return-printable';
import {
  INVOICE_ID,
  ORG,
  OTHER_ORG,
  PO_ID,
  SD_ID,
  SR_ID,
  printWorld,
  sampleStore,
} from './document-export.spec-fixture';

const world = (deletedAt: Date | null = null) => printWorld(sampleStore({ deletedAt }));
const column = (doc: { columns: { label: string }[]; rows: unknown[][] }, label: string) => {
  const i = doc.columns.findIndex(c => c.label === label);
  return doc.rows.map(r => r[i]);
};

describe('рахунок на бланку (BR-INV-028)', () => {
  // guards: BR-INV-028
  it('назва, номер, дата документа, платник з реквізитами, «Оплатити до», примітка', async () => {
    const doc = await loadInvoicePrintable(world().prisma, ORG, INVOICE_ID);

    expect(doc.title).toBe('Рахунок');
    expect(doc.number).toBe('INV/2026/0001');
    expect(doc.date).toBe('05.11.2026');
    expect(doc.orgParty).toBe('Постачальник');
    expect(doc.parties).toEqual([
      { label: 'Платник', lines: ['Петренко Іван', 'Тел.: +380671234567'] },
    ]);
    expect(doc.fields).toEqual([{ label: 'Оплатити до', value: '19.11.2026' }]);
    expect(doc.notes).toBe('Оплата протягом 14 днів');
    expect(doc.deleted).toBe(false);
  });

  // guards: BR-INV-028
  it('рядки в порядку картки (sortOrder, createdAt, id), не в порядку сховища', async () => {
    const doc = await loadInvoicePrintable(world().prisma, ORG, INVOICE_ID);

    expect(column(doc, 'Найменування')).toEqual(['Масло 5W-30', 'Заміна масла', 'Ручний рядок']);
  });

  // guards: BR-INV-028
  it('одиниця рядка → базова одиниця товару; робота — «год», ручний рядок — «шт»', async () => {
    const doc = await loadInvoicePrintable(world().prisma, ORG, INVOICE_ID);

    expect(column(doc, 'Од.')).toEqual(['л', 'год', 'шт']);
    expect(column(doc, 'Кількість')).toEqual([2, 1.5, 1]);
    expect(column(doc, 'Сума')).toEqual([360, 720, 120]);
  });

  // guards: BR-INV-028
  it('підсумки «Разом» / «ПДВ» / «До сплати» — суми рахунку, як у GET /invoices/:id/pdf', async () => {
    const doc = await loadInvoicePrintable(world().prisma, ORG, INVOICE_ID);

    expect(doc.totals).toEqual([
      { label: 'Разом', value: 1000 },
      { label: 'ПДВ', value: 200 },
      { label: 'До сплати', value: 1200, strong: true },
    ]);
  });

  // guards: BR-INV-028
  it("ім'я файла — «Рахунок-<номер>», символи «/» у номері замінено на «-»", async () => {
    const doc = await loadInvoicePrintable(world().prisma, ORG, INVOICE_ID);

    expect(doc.filenameBase).toBe('Рахунок-INV-2026-0001');
  });

  // guards: BR-INV-028
  it('позначений на видалення — знаходиться й друкується з позначкою «ВИДАЛЕНО»', async () => {
    const w = world(new Date('2026-11-05T09:00:00Z'));
    const doc = await loadInvoicePrintable(w.prisma, ORG, INVOICE_ID);

    expect(doc.deleted).toBe(true);
    expect(w.reads[0]).toEqual({ id: INVOICE_ID, orgId: ORG });
  });

  // guards: BR-INV-028
  it('рахунок іншої організації — 404', async () => {
    await expect(loadInvoicePrintable(world().prisma, OTHER_ORG, INVOICE_ID)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('замовлення постачальнику на бланку (BR-PO-016)', () => {
  // guards: BR-PO-016
  it('постачальник, склад, договір, дата оплати; рядки в порядку картки, видалений рядок — ні', async () => {
    const doc = await loadPurchaseOrderPrintable(world().prisma, ORG, PO_ID);

    expect(doc.title).toBe('Замовлення постачальнику');
    expect(doc.date).toBe('04.11.2026');
    expect(doc.parties).toEqual([
      {
        label: 'Постачальник',
        lines: ['ТОВ Постачальник', 'ЄДРПОУ: 12345678', 'Тел.: +380501112233'],
      },
    ]);
    expect(doc.fields).toEqual([
      { label: 'Склад', value: 'Основний склад' },
      { label: 'Договір', value: 'Д-15' },
      { label: 'Дата оплати', value: '20.11.2026' },
    ]);
    expect(column(doc, 'Найменування')).toEqual(['Комплект ГРМ', 'Фільтр повітряний']);
  });

  // guards: BR-PO-016
  it('одиниця рядка → базова; сума рядка = кількість × ціна; ПДВ рядка; «ПДВ» і «Разом» — як у картці', async () => {
    const doc = await loadPurchaseOrderPrintable(world().prisma, ORG, PO_ID);

    expect(column(doc, 'Од.')).toEqual(['компл', 'шт']);
    expect(column(doc, 'ПДВ')).toEqual([83.33, 25]);
    expect(column(doc, 'Сума')).toEqual([500, 150]);
    expect(doc.totals).toEqual([
      { label: 'ПДВ', value: 108.33 },
      { label: 'Разом', value: 650, strong: true },
    ]);
    expect(doc.currencyCode).toBe('UAH');
    expect(doc.filenameBase).toBe('Замовлення-PO-0007');
  });

  // guards: BR-PO-016
  it('замовлення без ПДВ — без колонки й рядка ПДВ', async () => {
    const store = sampleStore();
    const po = store.purchaseOrder![0]!;
    po.totalVat = 0;
    for (const l of po.lines as { vatAmount: number }[]) l.vatAmount = 0;
    const doc = await loadPurchaseOrderPrintable(printWorld(store).prisma, ORG, PO_ID);

    expect(doc.columns.map(c => c.label)).not.toContain('ПДВ');
    expect(doc.totals).toEqual([{ label: 'Разом', value: 650, strong: true }]);
  });

  // guards: BR-PO-016
  it('видалене — з позначкою; іншої організації — 404', async () => {
    const doc = await loadPurchaseOrderPrintable(world(new Date()).prisma, ORG, PO_ID);
    expect(doc.deleted).toBe(true);
    await expect(loadPurchaseOrderPrintable(world().prisma, OTHER_ORG, PO_ID)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('складський документ на бланку (BR-SDOC-009)', () => {
  // guards: BR-SDOC-009
  it('тип у назві, склад і склад призначення переміщення, дата проведення за Києвом', async () => {
    const doc = await loadStockDocumentPrintable(world().prisma, ORG, SD_ID);

    expect(doc.title).toBe('Переміщення');
    expect(doc.fields).toEqual([
      { label: 'Склад', value: 'Основний склад' },
      { label: 'Склад призначення', value: 'Склад філії' },
      { label: 'Проведено', value: '03.11.2026' },
    ]);
    expect(doc.filenameBase).toBe('Переміщення-SD-0003');
  });

  // guards: BR-SDOC-009
  it('сума рядка = кількість × ціна (до копійки); рядок без ціни — без ціни й суми; «Разом» — рядки з ціною', async () => {
    const doc = await loadStockDocumentPrintable(world().prisma, ORG, SD_ID);

    expect(column(doc, 'Найменування')).toEqual(['Мастило', 'Хомут']);
    expect(column(doc, 'Од.')).toEqual(['кг', 'шт']);
    expect(column(doc, 'Ціна')).toEqual([100.05, null]);
    // 0,3 × 100,05 = 30,015 → 30,02 (сума рядка округлена, клас Bug #811)
    expect(column(doc, 'Сума')).toEqual([30.02, null]);
    expect(doc.totals).toEqual([{ label: 'Разом', value: 30.02, strong: true }]);
  });

  // guards: BR-SDOC-009
  it('жоден рядок без ціни — без «Разом»', async () => {
    const store = sampleStore();
    for (const l of store.stockDocument![0]!.lines as { price: number | null }[]) l.price = null;
    const doc = await loadStockDocumentPrintable(printWorld(store).prisma, ORG, SD_ID);

    expect(doc.totals).toEqual([]);
  });

  // guards: BR-SDOC-009
  it.each([
    ['WRITEOFF', 'Списання', 'Списання'],
    ['OPENING_BALANCE', 'Введення залишків', 'Залишки'],
    ['RECEIPT', 'Оприбуткування', 'Оприбуткування'],
  ])('тип %s — назва «%s», файл «%s-<номер>»', async (type, title, prefix) => {
    const store = sampleStore();
    store.stockDocument![0]!.type = type;
    const doc = await loadStockDocumentPrintable(printWorld(store).prisma, ORG, SD_ID);

    expect(doc.title).toBe(title);
    expect(doc.filenameBase).toBe(`${prefix}-SD-0003`);
    expect(doc.fields.map(f => f.label)).not.toContain('Склад призначення');
  });

  // guards: BR-SDOC-009
  it('видалений — з позначкою; іншої організації — 404', async () => {
    const doc = await loadStockDocumentPrintable(world(new Date()).prisma, ORG, SD_ID);
    expect(doc.deleted).toBe(true);
    await expect(loadStockDocumentPrintable(world().prisma, OTHER_ORG, SD_ID)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('повернення постачальнику на бланку (BR-SRET-014)', () => {
  // guards: BR-SRET-014
  it('постачальник, склад, замовлення-джерело; рядки в порядку картки; «Разом» = totalAmount без ПДВ', async () => {
    const doc = await loadSupplierReturnPrintable(world().prisma, ORG, SR_ID);

    expect(doc.title).toBe('Повернення постачальнику');
    expect(doc.fields).toEqual([
      { label: 'Склад', value: 'Основний склад' },
      { label: 'Замовлення', value: 'PO-0007' },
    ]);
    expect(column(doc, 'Найменування')).toEqual(['Фільтр', 'Свічка']);
    expect(column(doc, 'Сума')).toEqual([150, 80]);
    expect(doc.columns.map(c => c.label)).not.toContain('ПДВ');
    expect(doc.totals).toEqual([{ label: 'Разом', value: 230, strong: true }]);
    expect(doc.filenameBase).toBe('Повернення-SR-0002');
  });

  // guards: BR-SRET-014
  it('видалене — з позначкою; іншої організації — 404', async () => {
    const doc = await loadSupplierReturnPrintable(world(new Date()).prisma, ORG, SR_ID);
    expect(doc.deleted).toBe(true);
    await expect(loadSupplierReturnPrintable(world().prisma, OTHER_ORG, SR_ID)).rejects.toThrow(
      NotFoundException,
    );
  });
});
