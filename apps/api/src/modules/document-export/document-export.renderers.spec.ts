/**
 * Один бланк — три формати (BR-INV-028, BR-PO-016, BR-SDOC-009, BR-SRET-014): PDF (pdfmake),
 * XLSX (exceljs) і DOCX (OOXML) будуються з тієї самої `PrintableDocument` і несуть ті самі рядки,
 * підсумки й позначку «ВИДАЛЕНО». XLSX: кількості й суми — числа з форматом, текст на `= + - @` —
 * з апострофом (`xlsxSafe`). Мутація (2026-11-05): прибрати `xlsxSafe` з рядків XLSX → падає
 * «формула в назві товару».
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
import { PdfService } from '../pdf/pdf.service';
import type { OrgPrintInfoService } from '../pdf/org-print-info.service';
import { DocumentExportService } from './document-export.service';
import { renderDocumentXlsx } from './document-xlsx.renderer';
import { renderDocumentDocx } from './document-docx.renderer';
import type { PrintableDocument } from './printable-document';
import {
  INVOICE_ID,
  ORG,
  ORG_INFO,
  SD_ID,
  printWorld,
  sampleStore,
} from './document-export.spec-fixture';

const DOC: PrintableDocument = {
  title: 'Рахунок',
  number: 'INV-1',
  date: '05.11.2026',
  deleted: true,
  currencyCode: null,
  parties: [{ label: 'Платник', lines: ['=HYPERLINK("http://x")', 'Тел.: +380'] }],
  fields: [{ label: 'Оплатити до', value: '19.11.2026' }],
  columns: [
    { label: 'Найменування', kind: 'text' },
    { label: 'Кількість', kind: 'qty' },
    { label: 'Ціна', kind: 'money' },
    { label: 'Сума', kind: 'money' },
  ],
  rows: [
    ['=SUM(A1:A9)', 1.5, 1250, 1875],
    ['Гайка <M8> & шайба', 2, null, null],
  ],
  totals: [
    { label: 'Разом', value: 1875 },
    { label: 'До сплати', value: 1875, strong: true },
  ],
  notes: 'Примітка документа',
  filenameBase: 'Рахунок-INV-1',
};

/** Усі тексти вузла pdfmake (рядки таблиць, стовпці, стеки). */
function pdfTexts(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(pdfTexts);
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    return [
      ...(typeof o.text === 'string' ? [o.text] : []),
      ...pdfTexts(o.content),
      ...pdfTexts(o.columns),
      ...pdfTexts(o.stack),
      ...pdfTexts((o.table as { body?: unknown } | undefined)?.body),
    ];
  }
  return [];
}

async function readXlsx(buf: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.worksheets[0]!;
}

function findCell(ws: ExcelJS.Worksheet, value: unknown): ExcelJS.Cell | undefined {
  let hit: ExcelJS.Cell | undefined;
  ws.eachRow(row =>
    row.eachCell(cell => {
      if (!hit && cell.value === value) hit = cell;
    }),
  );
  return hit;
}

/** Пробіли-розділювачі розрядів `Intl` (U+00A0, U+202F) → звичайні: так легше читати очікування. */
const norm = (s: string): string => s.replace(/[  ]/g, ' ');

const docxXml = (buf: Buffer): string => norm(new PizZip(buf).file('word/document.xml')!.asText());

describe('PDF документа (pdfmake)', () => {
  let pdf: PdfService;
  beforeAll(() => {
    pdf = new PdfService();
  });
  afterEach(() => vi.restoreAllMocks());

  // guards: BR-INV-028, BR-SDOC-009
  it('назва з номером, «ВИДАЛЕНО», реквізити, рядки (сума з «грн», без ціни — порожньо), підсумки', async () => {
    const spy = vi.spyOn(
      pdf as unknown as { buildBuffer: (d: unknown) => Promise<Buffer> },
      'buildBuffer',
    );
    const buf = await pdf.generateDocumentPdf(ORG_INFO, DOC);

    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    const texts = pdfTexts(spy.mock.calls[0]![0]).map(norm);
    expect(texts).toEqual(
      expect.arrayContaining([
        'СТО Альфа',
        'Рахунок № INV-1',
        'ВИДАЛЕНО',
        'Дата: 05.11.2026',
        'Оплатити до: 19.11.2026',
        'Платник:',
        '1 875,00 грн',
        '1,5',
        'Примітка: Примітка документа',
        'До сплати:',
      ]),
    );
    expect(texts.filter(t => t === '')).not.toHaveLength(0);
  }, 20_000);

  // guards: BR-INV-028
  it('не видалений документ — без позначки', async () => {
    const spy = vi.spyOn(
      pdf as unknown as { buildBuffer: (d: unknown) => Promise<Buffer> },
      'buildBuffer',
    );
    await pdf.generateDocumentPdf(ORG_INFO, { ...DOC, deleted: false });

    expect(pdfTexts(spy.mock.calls[0]![0])).not.toContain('ВИДАЛЕНО');
  }, 20_000);
});

describe('XLSX документа (exceljs)', () => {
  // guards: BR-INV-028, BR-PO-016, BR-SDOC-009, BR-SRET-014
  it('кількості й суми — числа з форматом; рядок без ціни — порожня комірка', async () => {
    const ws = await readXlsx(await renderDocumentXlsx(ORG_INFO, DOC));

    const qty = findCell(ws, 1.5)!;
    expect(qty.numFmt).toBe('#,##0.###');
    const price = findCell(ws, 1250)!;
    expect(price.numFmt).toBe('#,##0.00');
    expect(typeof price.value).toBe('number');
    const priceless = ws.getRow(Number(findCell(ws, 'Гайка <M8> & шайба')!.row));
    expect(priceless.getCell(3).value).toBeNull();
    expect(findCell(ws, 'Ціна, грн')).toBeDefined();
  });

  // guards: BR-INV-028, BR-PO-016, BR-SDOC-009, BR-SRET-014
  it('формула в назві товару чи контрагента — з апострофом (xlsxSafe)', async () => {
    const ws = await readXlsx(await renderDocumentXlsx(ORG_INFO, DOC));

    expect(findCell(ws, "'=SUM(A1:A9)")).toBeDefined();
    expect(findCell(ws, '=SUM(A1:A9)')).toBeUndefined();
    expect(findCell(ws, '\'=HYPERLINK("http://x")')).toBeDefined();
  });

  // guards: BR-INV-028
  it('назва з номером, «ВИДАЛЕНО», підсумок «До сплати» — числом', async () => {
    const ws = await readXlsx(await renderDocumentXlsx(ORG_INFO, DOC));

    expect(findCell(ws, 'Рахунок № INV-1')).toBeDefined();
    expect(findCell(ws, 'ВИДАЛЕНО')).toBeDefined();
    const label = findCell(ws, 'До сплати:')!;
    const value = ws.getRow(Number(label.row)).getCell(Number(label.col) + 1);
    expect(value.value).toBe(1875);
  });
});

describe('DOCX документа (OOXML)', () => {
  // guards: BR-INV-028, BR-SRET-014
  it('назва, «ВИДАЛЕНО», таблиця рядків, текст екранується, підсумки з валютою', () => {
    const xml = docxXml(renderDocumentDocx(ORG_INFO, DOC));

    expect(xml).toContain('Рахунок № INV-1');
    expect(xml).toContain('ВИДАЛЕНО');
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('Гайка &lt;M8&gt; &amp; шайба');
    expect(xml).toContain('1 875,00');
    expect(xml).toContain('До сплати: 1 875,00 грн');
  });

  // guards: BR-INV-028
  it('не видалений — без позначки', () => {
    expect(docxXml(renderDocumentDocx(ORG_INFO, { ...DOC, deleted: false }))).not.toContain(
      'ВИДАЛЕНО',
    );
  });
});

describe('DocumentExportService — файл і сторона-організація', () => {
  const service = (store = sampleStore()) =>
    new DocumentExportService(
      printWorld(store).prisma,
      { get: () => Promise.resolve(ORG_INFO) } as unknown as OrgPrintInfoService,
      new PdfService(),
    );

  // guards: BR-INV-028
  it("рахунок: «Постачальник» — організація з реквізитами перед платником; ім'я й тип файла", async () => {
    const file = await service().export('invoice', ORG, INVOICE_ID, 'docx');
    const xml = docxXml(file.buffer);

    expect(file.filename).toBe('Рахунок-INV-2026-0001.docx');
    expect(file.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(xml.indexOf('Постачальник:')).toBeGreaterThan(-1);
    expect(xml.indexOf('Постачальник:')).toBeLessThan(xml.indexOf('Платник:'));
    expect(xml).toContain('ЄДРПОУ: 87654321');
  });

  // guards: BR-INV-028, BR-SDOC-009
  it('ті самі підсумки у трьох форматах', async () => {
    const svc = service();
    const [pdf, xlsx, docx] = await Promise.all(
      (['pdf', 'xlsx', 'docx'] as const).map(f => svc.export('invoice', ORG, INVOICE_ID, f)),
    );
    expect(pdf.filename).toBe('Рахунок-INV-2026-0001.pdf');
    expect(pdf.contentType).toBe('application/pdf');
    const ws = await readXlsx(xlsx.buffer);
    const label = findCell(ws, 'До сплати:')!;
    expect(ws.getRow(Number(label.row)).getCell(Number(label.col) + 1).value).toBe(1200);
    expect(docxXml(docx.buffer)).toContain('До сплати: 1 200,00 грн');
  }, 20_000);

  // guards: BR-SDOC-009
  it("складський документ: ім'я файла за типом, без сторони-організації", async () => {
    const file = await service().export('stockDocument', ORG, SD_ID, 'xlsx');

    expect(file.filename).toBe('Переміщення-SD-0003.xlsx');
    const ws = await readXlsx(file.buffer);
    expect(findCell(ws, 'Постачальник:')).toBeUndefined();
  });
});
