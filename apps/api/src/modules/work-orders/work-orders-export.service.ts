import { Injectable } from '@nestjs/common';
import { plannedWorkOrderTotals } from '../../common/utils/vat';
import ExcelJS from 'exceljs';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaService } from '../../prisma/prisma.service';
import { runUnscoped } from '../../common/tenant/tenant-context';
import { loadShareableWorkOrder } from './work-order-share-token';
import { xlsxSafe } from '../../common/office/xlsx-safe';
import {
  buildDocx,
  docxParagraph,
  docxPara,
  docxRun,
  docxTable,
  docxTableRow,
} from '../../common/office/docx';
import { safeFilenamePart } from '../../common/http/send-file';

interface EstimateForExport {
  number: string;
  orgName: string;
  orgLogoUrl: string | null;
  branchName: string;
  counterpartyName: string;
  vehicleSummary: string;
  documentDate: string;
  description: string;
  totalLabor: number;
  totalParts: number;
  /** Сума без ПДВ; дорівнює totalAmount, коли ПДВ немає. */
  totalNet: number;
  totalVat: number;
  /** Сума до сплати (з ПДВ). */
  totalAmount: number;
  lines: { name: string; normoHours: number; price: number; amount: number }[];
  parts: { name: string; quantity: number; unit: string; price: number; amount: number }[];
}

/** Підпис підсумку: коли в сумі є ПДВ, клієнт має бачити це в самому підписі. */
const grandTotalLabel = (d: { totalVat: number }): string =>
  d.totalVat > 0 ? 'ЗАГАЛЬНА СУМА З ПДВ' : 'ЗАГАЛЬНА СУМА';

const UAH_FMT = new Intl.NumberFormat('uk-UA', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const DATE_FMT = new Intl.DateTimeFormat('uk-UA');

function fmt(n: number) {
  return UAH_FMT.format(n);
}

@Injectable()
export class EstimateExportService {
  constructor(private readonly prisma: PrismaService) {}

  async getEstimateData(token: string): Promise<EstimateForExport> {
    // A1: публічний неавтентифікований експорт — orgId відсутній; наряд ідентифікується за унікальним
    // shareToken (16 байт), а не за tenant. GoodUoM-lookup нижче теж без orgId. Обгортаємо весь метод у
    // runUnscoped, щоб tenant-guard пропустив ці легітимні tenant-less запити (симетрично findByShareToken).
    return runUnscoped(async () => {
      // BR-WO-032: той самий відбір, що й JSON-кошторис — прострочений токен не експортує.
      const wo = await loadShareableWorkOrder(this.prisma, token);

      // sto-optimize 2026-06-17: tier merger — org та uoms обидва залежать лише
      // від wo (orgId + parts.unitOfMeasureId). Раніше: 2 RTT sequential. Тепер
      // 1 RTT паралельно. Викликається з 3 export-endpoint (PDF/XLSX/DOCX) —
      // кожен export ділиться TTFB save рівномірно. Symmetric з findByShareToken.
      const uomIds = wo.parts.map(p => p.unitOfMeasureId).filter((x): x is string => !!x);
      const [org, uoms] = await Promise.all([
        this.prisma.organisation.findFirst({
          where: { id: wo.orgId },
          select: { name: true, logoUrl: true },
        }),
        uomIds.length > 0
          ? this.prisma.goodUoM.findMany({
              where: { id: { in: uomIds } },
              select: { id: true, unitOfMeasure: { select: { shortName: true } } },
            })
          : Promise.resolve([] as { id: string; unitOfMeasure: { shortName: string } }[]),
      ]);

      const cp = wo.counterparty;
      const counterpartyName = cp
        ? [cp.companyName, cp.lastName, cp.firstName].filter(Boolean).join(' ') || '—'
        : '—';
      const vehicleSummary = wo.vehicle
        ? `${wo.vehicle.make} ${wo.vehicle.model}${wo.vehicle.licensePlate ? ` (${wo.vehicle.licensePlate})` : ''}`
        : '—';

      const uomMap: Record<string, string> = {};
      for (const u of uoms) uomMap[u.id] = u.unitOfMeasure.shortName;

      return {
        number: wo.number,
        orgName: org?.name ?? '',
        orgLogoUrl: org?.logoUrl ?? null,
        branchName: wo.branch?.name ?? '',
        counterpartyName,
        vehicleSummary,
        documentDate: wo.documentDate
          ? DATE_FMT.format(wo.documentDate)
          : DATE_FMT.format(new Date()),
        description: wo.description ?? '',
        totalLabor: Number(wo.totalLabor),
        totalParts: Number(wo.totalParts),
        // PDF/XLSX/DOCX estimate shows the PLANNED total, not the actual one: the client sees an
        // estimate, not a completion act, and row math (normoHours × price) must match it.
        // VAT follows the work order (BR-WO-007). Symmetric with findByShareToken (JSON endpoint).
        ...plannedWorkOrderTotals(wo),
        lines: wo.lines.map(l => ({
          name: l.work?.name ?? '—',
          normoHours: l.normoHours,
          price: Number(l.price),
          amount: Number(l.amount),
        })),
        parts: wo.parts.map(p => ({
          name: p.good?.name ?? '—',
          quantity: p.quantity,
          unit:
            (p.unitOfMeasureId && uomMap[p.unitOfMeasureId]) ??
            p.good?.unitOfMeasure?.shortName ??
            p.good?.unit ??
            'шт',
          price: Number(p.price),
          amount: Number(p.amount),
        })),
      };
    });
  }

  // ─── PDF ────────────────────────────────────────────────────────────────────

  async generatePdf(token: string): Promise<{ buffer: Buffer; filename: string }> {
    const d = await this.getEstimateData(token);

    // Locate Roboto TTFs from pdfmake's font bundle.
    // __dirname in compiled dist = apps/api/dist/ → 3 levels up = monorepo root
    // __dirname in ts-node dev  = apps/api/src/modules/work-orders/ → 5 levels up = monorepo root
    const monorepoCandidates = [
      path.resolve(__dirname, '..', '..', '..'), // dist/ → monorepo root
      path.resolve(__dirname, '..', '..', '..', '..', '..'), // src/…/ → monorepo root
      process.cwd(), // cwd if launched from root
    ];
    const fontCandidates = monorepoCandidates.flatMap(root => [
      path.join(root, 'apps', 'api', 'node_modules', 'pdfmake', 'fonts', 'Roboto'),
      path.join(root, 'node_modules', 'pdfmake', 'fonts', 'Roboto'),
      path.join(
        root,
        'node_modules',
        '.pnpm',
        'pdfmake@0.3.9',
        'node_modules',
        'pdfmake',
        'fonts',
        'Roboto',
      ),
    ]);
    const robotoDir = fontCandidates.find(p => fs.existsSync(path.join(p, 'Roboto-Regular.ttf')));
    if (!robotoDir) throw new Error('Roboto fonts not found for PDF generation');

    // pdfkit uses `export =` so require() returns the constructor directly
    /* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
    const PDFDocumentCtor: new (
      opts: Record<string, unknown>,
    ) => PDFKit.PDFDocument = require('pdfkit');
    /* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const doc: PDFKit.PDFDocument = new PDFDocumentCtor({
      size: 'A4',
      margin: 40,
      autoFirstPage: true,
    });
    doc.registerFont('Roboto', path.join(robotoDir, 'Roboto-Regular.ttf'));
    doc.registerFont('Roboto-Bold', path.join(robotoDir, 'Roboto-Medium.ttf'));

    const PAGE_W = doc.page.width - 80; // usable width (margin 40 each side)
    const GRAY = '#666666';
    const HEADER_BG = '#D9E1F2';
    const TOTAL_BG = '#DCE6F1';
    const GRAND_BG = '#FFF2CC';
    const BORDER = '#CCCCCC';
    const ROW_H = 16;
    const HEAD_H = 18;

    // ── Helper: draw table ──────────────────────────────────────────────────
    function drawTable(
      doc: PDFKit.PDFDocument,
      headers: string[],
      rows: string[][],
      colWidths: number[],
      totalRow?: string[],
    ) {
      const x0 = doc.page.margins.left;
      let y = doc.y;

      const drawRowBg = (rowY: number, h: number, bg: string) => {
        doc.save().rect(x0, rowY, PAGE_W, h).fill(bg).restore();
      };
      const drawCellText = (
        text: string,
        cx: number,
        cy: number,
        w: number,
        h: number,
        bold = false,
        align: 'left' | 'right' | 'center' = 'left',
        color = '#000000',
      ) => {
        doc
          .font(bold ? 'Roboto-Bold' : 'Roboto')
          .fontSize(8)
          .fillColor(color)
          .text(text, cx + 3, cy + (h - 8) / 2, { width: w - 6, align, lineBreak: false });
      };
      const drawBorders = (rowY: number, h: number) => {
        doc.save().strokeColor(BORDER).lineWidth(0.5);
        // horizontal
        doc
          .moveTo(x0, rowY)
          .lineTo(x0 + PAGE_W, rowY)
          .stroke();
        doc
          .moveTo(x0, rowY + h)
          .lineTo(x0 + PAGE_W, rowY + h)
          .stroke();
        // vertical
        let cx = x0;
        for (let i = 0; i <= colWidths.length; i++) {
          doc
            .moveTo(cx, rowY)
            .lineTo(cx, rowY + h)
            .stroke();
          cx += colWidths[i] ?? 0;
        }
        doc.restore();
      };

      // Header row
      drawRowBg(y, HEAD_H, HEADER_BG);
      let cx = x0;
      headers.forEach((h, i) => {
        const isRight = i > 0;
        drawCellText(h, cx, y, colWidths[i], HEAD_H, true, isRight ? 'right' : 'left');
        cx += colWidths[i];
      });
      drawBorders(y, HEAD_H);
      y += HEAD_H;

      // Data rows
      rows.forEach((row, ri) => {
        if (y + ROW_H > doc.page.height - doc.page.margins.bottom) {
          doc.addPage();
          y = doc.page.margins.top;
        }
        if (ri % 2 === 1) drawRowBg(y, ROW_H, '#F7F9FC');
        cx = x0;
        row.forEach((cell, i) => {
          const isRight = i > 0;
          drawCellText(cell, cx, y, colWidths[i], ROW_H, false, isRight ? 'right' : 'left');
          cx += colWidths[i];
        });
        drawBorders(y, ROW_H);
        y += ROW_H;
      });

      // Total row
      if (totalRow) {
        if (y + ROW_H > doc.page.height - doc.page.margins.bottom) {
          doc.addPage();
          y = doc.page.margins.top;
        }
        drawRowBg(y, ROW_H, TOTAL_BG);
        cx = x0;
        totalRow.forEach((cell, i) => {
          const isRight = i > 0;
          drawCellText(cell, cx, y, colWidths[i], ROW_H, true, isRight ? 'right' : 'left');
          cx += colWidths[i];
        });
        drawBorders(y, ROW_H);
        y += ROW_H;
      }

      doc.y = y + 8;
    }

    // ── Document content ────────────────────────────────────────────────────
    if (d.orgName) {
      doc.font('Roboto-Bold').fontSize(10).fillColor(GRAY).text(d.orgName);
    }
    doc.font('Roboto-Bold').fontSize(16).fillColor('#000000').text(`Кошторис ${d.number}`);
    if (d.branchName) {
      doc.font('Roboto').fontSize(9).fillColor(GRAY).text(d.branchName);
    }
    doc.moveDown(0.5);

    // Info block
    const infoRows: [string, string][] = [
      ['Клієнт', d.counterpartyName],
      ['Автомобіль', d.vehicleSummary],
      ['Дата', d.documentDate],
      ...(d.description ? ([['Примітка', d.description]] as [string, string][]) : []),
    ];
    for (const [label, value] of infoRows) {
      const y = doc.y;
      doc.font('Roboto').fontSize(9).fillColor(GRAY).text(label, { continued: false, width: 90 });
      doc
        .font('Roboto')
        .fontSize(9)
        .fillColor('#000000')
        .text(value, 130, y, { width: PAGE_W - 90 });
    }
    doc.moveDown(0.8);

    // Works table
    if (d.lines.length > 0) {
      doc.font('Roboto-Bold').fontSize(11).fillColor('#000000').text('Роботи');
      doc.moveDown(0.3);
      const colW = [PAGE_W - 135, 45, 45, 45];
      drawTable(
        doc,
        ['Назва', 'Н/год', 'Ціна, грн', 'Сума, грн'],
        d.lines.map(l => [l.name, String(l.normoHours), fmt(l.price), fmt(l.amount)]),
        colW,
        ['', '', 'Разом роботи:', fmt(d.totalLabor)],
      );
    }

    // Parts table
    if (d.parts.length > 0) {
      doc.font('Roboto-Bold').fontSize(11).fillColor('#000000').text('Запчастини та матеріали');
      doc.moveDown(0.3);
      const colW = [PAGE_W - 175, 50, 30, 47, 48];
      drawTable(
        doc,
        ['Назва', 'Кількість', 'Од.', 'Ціна, грн', 'Сума, грн'],
        d.parts.map(p => [p.name, String(p.quantity), p.unit, fmt(p.price), fmt(p.amount)]),
        colW,
        ['', '', '', 'Разом запч.:', fmt(d.totalParts)],
      );
    }

    // Сума без ПДВ / ПДВ — лише коли ПДВ є; тоді «загальна сума» нижче — це сума з ПДВ
    if (d.totalVat > 0) {
      doc.moveDown(0.3);
      for (const [label, value] of [
        ['Сума без ПДВ', d.totalNet],
        ['ПДВ', d.totalVat],
      ] as const) {
        doc
          .font('Roboto')
          .fontSize(10)
          .fillColor('#000000')
          .text(`${label}: ${fmt(value)} грн`, doc.page.margins.left + 4, doc.y, {
            width: PAGE_W - 8,
            align: 'right',
          });
      }
    }

    // Grand total
    doc.moveDown(0.3);
    const gtY = doc.y;
    doc.save().rect(doc.page.margins.left, gtY, PAGE_W, 22).fill(GRAND_BG).restore();
    doc
      .font('Roboto-Bold')
      .fontSize(12)
      .fillColor('#000000')
      .text(
        `${grandTotalLabel(d)}: ${fmt(d.totalAmount)} грн`,
        doc.page.margins.left + 4,
        gtY + 5,
        {
          width: PAGE_W - 8,
          align: 'right',
        },
      );

    // Collect buffer
    const chunks: Buffer[] = [];
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    });

    const safeNum = safeFilenamePart(d.number);
    return { buffer, filename: `Кошторис-${safeNum}.pdf` };
  }

  // ─── XLSX ───────────────────────────────────────────────────────────────────

  async generateXlsx(token: string): Promise<{ buffer: Buffer; filename: string }> {
    const d = await this.getEstimateData(token);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'OneService';

    const ws = wb.addWorksheet('Кошторис');

    // Column widths
    ws.columns = [
      { key: 'a', width: 44 },
      { key: 'b', width: 10 },
      { key: 'c', width: 14 },
      { key: 'e', width: 14 },
    ];

    const titleFont = { name: 'Calibri', bold: true, size: 14 } as const;
    const headerFont = { name: 'Calibri', bold: true, size: 10 } as const;
    const bodyFont = { name: 'Calibri', size: 10 } as const;
    const headerFill: ExcelJS.Fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    const totalFill: ExcelJS.Fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFDCE6F1' },
    };
    const thinBorder: ExcelJS.Border = { style: 'thin', color: { argb: 'FFCCCCCC' } };
    const allBorders = { top: thinBorder, left: thinBorder, bottom: thinBorder, right: thinBorder };

    let row = 1;

    // Header
    if (d.orgName) {
      ws.getCell(`A${row}`).value = xlsxSafe(d.orgName);
      ws.getCell(`A${row}`).font = { name: 'Calibri', bold: true, size: 11 };
      row++;
    }

    ws.getCell(`A${row}`).value = `Кошторис ${d.number}`;
    ws.getCell(`A${row}`).font = titleFont;
    ws.mergeCells(`A${row}:D${row}`);
    row++;

    if (d.branchName) {
      ws.getCell(`A${row}`).value = xlsxSafe(d.branchName);
      ws.getCell(`A${row}`).font = { ...bodyFont, color: { argb: 'FF666666' } };
      row++;
    }
    row++;

    // Info block
    const infoRows: [string, string][] = [
      ['Клієнт', d.counterpartyName],
      ['Автомобіль', d.vehicleSummary],
      ['Дата', d.documentDate],
    ];
    if (d.description) infoRows.push(['Примітка', d.description]);

    for (const [label, value] of infoRows) {
      ws.getCell(`A${row}`).value = label;
      ws.getCell(`A${row}`).font = { ...bodyFont, color: { argb: 'FF888888' } };
      ws.getCell(`B${row}`).value = xlsxSafe(value);
      ws.mergeCells(`B${row}:D${row}`);
      ws.getCell(`B${row}`).font = bodyFont;
      row++;
    }
    row++;

    // Works table
    if (d.lines.length > 0) {
      ws.getCell(`A${row}`).value = 'Роботи';
      ws.getCell(`A${row}`).font = { ...headerFont, size: 11 };
      ws.mergeCells(`A${row}:D${row}`);
      row++;

      const wHdr = ['Назва', 'Н/год', 'Ціна, ₴', 'Сума, ₴'];
      ['A', 'B', 'C', 'D'].forEach((col, i) => {
        const cell = ws.getCell(`${col}${row}`);
        cell.value = wHdr[i];
        cell.font = headerFont;
        cell.fill = headerFill;
        cell.border = allBorders;
        cell.alignment = { horizontal: i === 0 ? 'left' : 'right' };
      });
      row++;

      for (const line of d.lines) {
        const cols = [line.name, line.normoHours, Number(line.price), Number(line.amount)];
        (['A', 'B', 'C', 'D'] as const).forEach((col, i) => {
          const cell = ws.getCell(`${col}${row}`);
          cell.value = xlsxSafe(cols[i]);
          cell.font = bodyFont;
          cell.border = allBorders;
          cell.alignment = { horizontal: i === 0 ? 'left' : 'right' };
          if (i >= 2) cell.numFmt = '#,##0.00';
        });
        row++;
      }

      // Works total
      ws.getCell(`C${row}`).value = 'Разом роботи:';
      ws.getCell(`C${row}`).font = headerFont;
      ws.getCell(`C${row}`).alignment = { horizontal: 'right' };
      ws.getCell(`D${row}`).value = d.totalLabor;
      ws.getCell(`D${row}`).font = headerFont;
      ws.getCell(`D${row}`).numFmt = '#,##0.00';
      ws.getCell(`D${row}`).alignment = { horizontal: 'right' };
      ws.getCell(`D${row}`).fill = totalFill;
      row += 2;
    }

    // Parts table
    if (d.parts.length > 0) {
      ws.getCell(`A${row}`).value = 'Запчастини та матеріали';
      ws.getCell(`A${row}`).font = { ...headerFont, size: 11 };
      ws.mergeCells(`A${row}:D${row}`);
      row++;

      // 5 columns for parts — need to add column E
      ws.getColumn(5).width = 14;
      const pHdr = ['Назва', 'Кількість', 'Од.', 'Ціна, ₴', 'Сума, ₴'];
      (['A', 'B', 'C', 'D', 'E'] as const).forEach((col, i) => {
        const cell = ws.getCell(`${col}${row}`);
        cell.value = pHdr[i];
        cell.font = headerFont;
        cell.fill = headerFill;
        cell.border = allBorders;
        cell.alignment = { horizontal: i === 0 ? 'left' : 'right' };
      });
      row++;

      for (const part of d.parts) {
        const cols = [part.name, part.quantity, part.unit, Number(part.price), Number(part.amount)];
        (['A', 'B', 'C', 'D', 'E'] as const).forEach((col, i) => {
          const cell = ws.getCell(`${col}${row}`);
          cell.value = xlsxSafe(cols[i]);
          cell.font = bodyFont;
          cell.border = allBorders;
          cell.alignment = { horizontal: i === 0 ? 'left' : 'right' };
          if (i === 3 || i === 4) cell.numFmt = '#,##0.00';
        });
        row++;
      }

      // Parts total
      ws.getCell(`D${row}`).value = 'Разом запчастини:';
      ws.getCell(`D${row}`).font = headerFont;
      ws.getCell(`D${row}`).alignment = { horizontal: 'right' };
      ws.getCell(`E${row}`).value = d.totalParts;
      ws.getCell(`E${row}`).font = headerFont;
      ws.getCell(`E${row}`).numFmt = '#,##0.00';
      ws.getCell(`E${row}`).alignment = { horizontal: 'right' };
      ws.getCell(`E${row}`).fill = totalFill;
      row += 2;
    }

    if (d.totalVat > 0) {
      for (const [label, value] of [
        ['Сума без ПДВ:', d.totalNet],
        ['ПДВ:', d.totalVat],
      ] as const) {
        ws.getCell(`C${row}`).value = label;
        ws.getCell(`C${row}`).alignment = { horizontal: 'right' };
        ws.mergeCells(`C${row}:D${row}`);
        ws.getCell(`E${row}`).value = value;
        ws.getCell(`E${row}`).numFmt = '#,##0.00 ₴';
        ws.getCell(`E${row}`).alignment = { horizontal: 'right' };
        row++;
      }
    }

    // Grand total
    ws.getCell(`C${row}`).value = `${grandTotalLabel(d)}:`;
    ws.getCell(`C${row}`).font = { ...headerFont, size: 12 };
    ws.getCell(`C${row}`).alignment = { horizontal: 'right' };
    ws.mergeCells(`C${row}:D${row}`);
    ws.getCell(`E${row}`).value = d.totalAmount;
    ws.getCell(`E${row}`).font = { name: 'Calibri', bold: true, size: 14 };
    ws.getCell(`E${row}`).numFmt = '#,##0.00 ₴';
    ws.getCell(`E${row}`).alignment = { horizontal: 'right' };
    ws.getCell(`E${row}`).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFF2CC' },
    };

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const safeNum = safeFilenamePart(d.number);
    return { buffer, filename: `Кошторис-${safeNum}.xlsx` };
  }

  // ─── DOCX ───────────────────────────────────────────────────────────────────

  async generateDocx(token: string): Promise<{ buffer: Buffer; filename: string }> {
    const d = await this.getEstimateData(token);

    const buffer = buildDocx(this.buildDocxBody(d), `Кошторис ${d.number}`);
    const safeNum = safeFilenamePart(d.number);
    return { buffer, filename: `Кошторис-${safeNum}.docx` };
  }

  private buildDocxBody(d: EstimateForExport): string[] {
    const rows: string[] = [];

    if (d.orgName) rows.push(docxPara(d.orgName, true, 22, '444444'));
    rows.push(docxPara(`Кошторис ${d.number}`, true, 28));
    if (d.branchName) rows.push(docxPara(d.branchName, false, 20, '666666'));
    rows.push(docxPara(''));

    // Info
    const info: [string, string][] = [
      ['Клієнт:', d.counterpartyName],
      ['Автомобіль:', d.vehicleSummary],
      ['Дата:', d.documentDate],
    ];
    if (d.description) info.push(['Примітка:', d.description]);
    for (const [lbl, val] of info) {
      rows.push(
        docxParagraph([
          docxRun(`${lbl} `, { bold: true, size: 20, color: '888888' }),
          docxRun(val, { size: 20 }),
        ]),
      );
    }
    rows.push(docxPara(''));

    // Works table
    if (d.lines.length > 0) {
      rows.push(docxPara('Роботи', true, 24));
      const worksTable = [
        docxTableRow(['Назва', 'Н/год', 'Ціна, ₴', 'Сума, ₴'], true, 'D9E1F2'),
        ...d.lines.map(l =>
          docxTableRow([l.name, String(l.normoHours), fmt(l.price), fmt(l.amount)]),
        ),
        docxTableRow(['', '', 'Разом роботи:', fmt(d.totalLabor)], true, 'DCE6F1'),
      ];
      rows.push(docxTable(worksTable, [5040, 1440, 1440, 1440]));
      rows.push(docxPara(''));
    }

    // Parts table
    if (d.parts.length > 0) {
      rows.push(docxPara('Запчастини та матеріали', true, 24));
      const partsTable = [
        docxTableRow(['Назва', 'Кількість', 'Од.', 'Ціна, ₴', 'Сума, ₴'], true, 'D9E1F2'),
        ...d.parts.map(p =>
          docxTableRow([p.name, String(p.quantity), p.unit, fmt(p.price), fmt(p.amount)]),
        ),
        docxTableRow(['', '', '', 'Разом запчастини:', fmt(d.totalParts)], true, 'DCE6F1'),
      ];
      rows.push(docxTable(partsTable, [4032, 1440, 648, 1440, 1800]));
      rows.push(docxPara(''));
    }

    if (d.totalVat > 0) {
      for (const [label, value] of [
        ['Сума без ПДВ', d.totalNet],
        ['ПДВ', d.totalVat],
      ] as const) {
        rows.push(docxParagraph(docxRun(`${label}: ${fmt(value)} ₴`), 'right'));
      }
    }

    // Grand total
    rows.push(
      docxParagraph(
        docxRun(`${grandTotalLabel(d)}: ${fmt(d.totalAmount)} ₴`, { bold: true, size: 28 }),
        'right',
      ),
    );
    return rows;
  }
}
