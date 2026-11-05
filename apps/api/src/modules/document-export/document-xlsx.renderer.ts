import ExcelJS from 'exceljs';
import { xlsxSafe } from '../../common/office/xlsx-safe';
import type { OrgPrintInfo } from '../pdf/org-print-info.types';
import {
  DELETED_MARK,
  columnLabel,
  currencySuffix,
  orgDetailLines,
  type PrintableDocument,
} from './printable-document';

const MONEY_NUM_FMT = '#,##0.00';
const QTY_NUM_FMT = '#,##0.###';

const FONT = { name: 'Calibri', size: 10 } as const;
const BOLD = { ...FONT, bold: true } as const;
const MUTED = { ...FONT, color: { argb: 'FF666666' } } as const;
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFD9E1F2' },
};
const THIN: ExcelJS.Border = { style: 'thin', color: { argb: 'FFCCCCCC' } };
const BORDERS = { top: THIN, left: THIN, bottom: THIN, right: THIN };

/**
 * XLSX друкованого документа: шапка організації, назва з номером, реквізити, таблиця рядків і
 * підсумки. Кількості й суми — числа з форматом (Excel рахує й сортує їх), вільний текст —
 * через `xlsxSafe` (захист від формул).
 */
export async function renderDocumentXlsx(
  org: OrgPrintInfo,
  doc: PrintableDocument,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OneService';
  const ws = wb.addWorksheet(doc.title.slice(0, 31));
  const last = Math.max(doc.columns.length, 2);
  ws.columns = doc.columns.map((c, i) => ({
    width: i === 0 ? 44 : c.kind === 'money' ? 16 : c.kind === 'qty' ? 12 : 10,
  }));

  let row = 1;
  /** Текстовий рядок шапки на всю ширину таблиці. */
  const line = (text: string, font: Partial<ExcelJS.Font>) => {
    const cell = ws.getCell(row, 1);
    cell.value = xlsxSafe(text);
    cell.font = font;
    ws.mergeCells(row, 1, row, last);
    row++;
  };

  line(org.name, { ...BOLD, size: 12 });
  for (const l of orgDetailLines(org)) line(l, MUTED);
  row++;
  line(`${doc.title} № ${doc.number}`, { ...BOLD, size: 14 });
  if (doc.deleted) line(DELETED_MARK, { ...BOLD, size: 12, color: { argb: 'FFC00000' } });
  line(`Дата: ${doc.date}`, FONT);
  for (const f of doc.fields) line(`${f.label}: ${f.value}`, FONT);
  for (const p of doc.parties) {
    line(`${p.label}:`, BOLD);
    for (const l of p.lines) line(l, FONT);
  }
  row++;

  doc.columns.forEach((c, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = columnLabel(c, doc.currencyCode);
    cell.font = BOLD;
    cell.fill = HEADER_FILL;
    cell.border = BORDERS;
    cell.alignment = { horizontal: c.kind === 'text' ? 'left' : 'right' };
  });
  row++;

  for (const r of doc.rows) {
    doc.columns.forEach((c, i) => {
      const cell = ws.getCell(row, i + 1);
      const v = r[i] ?? null;
      cell.value = typeof v === 'string' ? xlsxSafe(v) : v;
      cell.font = FONT;
      cell.border = BORDERS;
      if (c.kind !== 'text') {
        cell.alignment = { horizontal: 'right' };
        cell.numFmt = c.kind === 'money' ? MONEY_NUM_FMT : QTY_NUM_FMT;
      }
    });
    row++;
  }
  row++;

  const valueCol = doc.columns.length;
  for (const t of doc.totals) {
    const font = t.strong ? BOLD : FONT;
    const label = ws.getCell(row, Math.max(valueCol - 1, 1));
    label.value = `${t.label}:`;
    label.font = font;
    label.alignment = { horizontal: 'right' };
    const value = ws.getCell(row, valueCol);
    value.value = t.value;
    value.font = font;
    value.numFmt = `${MONEY_NUM_FMT} "${currencySuffix(doc.currencyCode)}"`;
    value.alignment = { horizontal: 'right' };
    row++;
  }

  if (doc.notes) {
    row++;
    line(`Примітка: ${doc.notes}`, FONT);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
