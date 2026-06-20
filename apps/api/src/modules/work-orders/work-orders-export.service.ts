import { Injectable, NotFoundException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaService } from '../../prisma/prisma.service';
import { SHAREABLE_STATUSES } from './work-orders.fsm';

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
  totalAmount: number;
  lines: { name: string; normoHours: number; price: number; amount: number }[];
  parts: { name: string; quantity: number; unit: string; price: number; amount: number }[];
}

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
    const wo = await this.prisma.workOrder.findFirst({
      where: { shareToken: token, deletedAt: null, status: { in: [...SHAREABLE_STATUSES] } },
      include: {
        vehicle: { select: { make: true, model: true, licensePlate: true } },
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        branch: { select: { name: true } },
        lines: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 500,
          select: {
            normoHours: true,
            price: true,
            amount: true,
            work: { select: { name: true } },
          },
        },
        parts: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 500,
          select: {
            quantity: true,
            price: true,
            amount: true,
            unitOfMeasureId: true,
            good: {
              select: { name: true, unit: true, unitOfMeasure: { select: { shortName: true } } },
            },
          },
        },
      },
    });
    if (!wo) throw new NotFoundException('Посилання не дійсне або термін дії минув');

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
      // PDF/XLSX/DOCX estimate shows PLANNED total, not actual.
      // wo.totalAmount = totalActualLabor + totalParts (uses actual hours when entered).
      // For SHAREABLE_STATUSES (DRAFT/ESTIMATE/APPROVED) this is semantically wrong:
      // the client sees an estimate, not a completion act.
      // Row math (normoHours × price) must match the grand total shown to the client.
      // Symmetric with work-orders.service.ts findByShareToken (JSON endpoint).
      totalAmount: Number(wo.totalLabor) + Number(wo.totalParts),
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const PDFDocumentCtor: new (
      opts: Record<string, unknown>,
    ) => PDFKit.PDFDocument = require('pdfkit');
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

    // Grand total
    doc.moveDown(0.3);
    const gtY = doc.y;
    doc.save().rect(doc.page.margins.left, gtY, PAGE_W, 22).fill(GRAND_BG).restore();
    doc
      .font('Roboto-Bold')
      .fontSize(12)
      .fillColor('#000000')
      .text(`ЗАГАЛЬНА СУМА: ${fmt(d.totalAmount)} грн`, doc.page.margins.left + 4, gtY + 5, {
        width: PAGE_W - 8,
        align: 'right',
      });

    // Collect buffer
    const chunks: Buffer[] = [];
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    });

    const safeNum = d.number.replace(/[/\\:*?"<>|]/g, '-');
    return { buffer, filename: `Кошторис-${safeNum}.pdf` };
  }

  // ─── XLSX ───────────────────────────────────────────────────────────────────

  async generateXlsx(token: string): Promise<{ buffer: Buffer; filename: string }> {
    const d = await this.getEstimateData(token);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'STO ERP';

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
    const labelFill: ExcelJS.Fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF2F2F2' },
    };
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
      ws.getCell(`A${row}`).value = d.orgName;
      ws.getCell(`A${row}`).font = { name: 'Calibri', bold: true, size: 11 };
      row++;
    }

    ws.getCell(`A${row}`).value = `Кошторис ${d.number}`;
    ws.getCell(`A${row}`).font = titleFont;
    ws.mergeCells(`A${row}:D${row}`);
    row++;

    if (d.branchName) {
      ws.getCell(`A${row}`).value = d.branchName;
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
      ws.getCell(`B${row}`).value = value;
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
          cell.value = cols[i] as string | number;
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
          cell.value = cols[i] as string | number;
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

    // Grand total
    ws.getCell(`C${row}`).value = 'ЗАГАЛЬНА СУМА:';
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
    const safeNum = d.number.replace(/[/\\:*?"<>|]/g, '-');
    return { buffer, filename: `Кошторис-${safeNum}.xlsx` };
  }

  // ─── DOCX ───────────────────────────────────────────────────────────────────

  async generateDocx(token: string): Promise<{ buffer: Buffer; filename: string }> {
    const d = await this.getEstimateData(token);

    // Build plain-text document since we generate without a template file
    // (no template bundled — use inline XML approach via docxtemplater on a minimal template)
    // We'll build the docx XML directly using a base template embedded as base64.
    // Simpler: use docxtemplater with a runtime-generated minimal .docx template.
    const content = this.buildDocxXml(d);
    const zip = new PizZip();
    zip.file('word/document.xml', content);
    zip.file('[Content_Types].xml', this.contentTypesXml());
    zip.file('_rels/.rels', this.rootRelsXml());
    zip.file('word/_rels/document.xml.rels', this.docRelsXml());
    zip.file('word/styles.xml', this.stylesXml());
    zip.file('word/settings.xml', this.settingsXml());
    zip.file('docProps/app.xml', this.appXml());
    zip.file('docProps/core.xml', this.coreXml(d.number));

    const buffer = Buffer.from(
      zip.generate({
        type: 'nodebuffer',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    );
    const safeNum = d.number.replace(/[/\\:*?"<>|]/g, '-');
    return { buffer, filename: `Кошторис-${safeNum}.docx` };
  }

  private esc(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private para(text: string, bold = false, size = 22, color = '000000'): string {
    const b = bold ? '<w:b/>' : '';
    return `<w:p><w:r><w:rPr>${b}<w:sz w:val="${size}"/><w:color w:val="${color}"/></w:rPr><w:t xml:space="preserve">${this.esc(text)}</w:t></w:r></w:p>`;
  }

  private tableRow(cells: string[], bold = false, shade?: string): string {
    const tds = cells.map((c, i) => {
      const align = i === 0 ? 'left' : 'right';
      const fill = shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : '';
      return `<w:tc><w:tcPr>${fill}<w:tcBorders>
        <w:top w:val="single" w:sz="4" w:color="CCCCCC"/>
        <w:left w:val="single" w:sz="4" w:color="CCCCCC"/>
        <w:bottom w:val="single" w:sz="4" w:color="CCCCCC"/>
        <w:right w:val="single" w:sz="4" w:color="CCCCCC"/>
      </w:tcBorders></w:tcPr>
      <w:p><w:pPr><w:jc w:val="${align}"/></w:pPr>
      <w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="18"/></w:rPr>
      <w:t xml:space="preserve">${this.esc(c)}</w:t></w:r></w:p></w:tc>`;
    });
    return `<w:tr>${tds.join('')}</w:tr>`;
  }

  private buildDocxXml(d: EstimateForExport): string {
    const rows: string[] = [];

    if (d.orgName) rows.push(this.para(d.orgName, true, 22, '444444'));
    rows.push(this.para(`Кошторис ${d.number}`, true, 28));
    if (d.branchName) rows.push(this.para(d.branchName, false, 20, '666666'));
    rows.push(this.para(''));

    // Info
    const info: [string, string][] = [
      ['Клієнт:', d.counterpartyName],
      ['Автомобіль:', d.vehicleSummary],
      ['Дата:', d.documentDate],
    ];
    if (d.description) info.push(['Примітка:', d.description]);
    for (const [lbl, val] of info) {
      rows.push(
        `<w:p><w:r><w:rPr><w:b/><w:sz w:val="20"/><w:color w:val="888888"/></w:rPr><w:t xml:space="preserve">${this.esc(lbl)} </w:t></w:r><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>${this.esc(val)}</w:t></w:r></w:p>`,
      );
    }
    rows.push(this.para(''));

    // Works table
    if (d.lines.length > 0) {
      rows.push(this.para('Роботи', true, 24));
      const worksTable = [
        this.tableRow(['Назва', 'Н/год', 'Ціна, ₴', 'Сума, ₴'], true, 'D9E1F2'),
        ...d.lines.map(l =>
          this.tableRow([l.name, String(l.normoHours), fmt(l.price), fmt(l.amount)]),
        ),
        this.tableRow(['', '', 'Разом роботи:', fmt(d.totalLabor)], true, 'DCE6F1'),
      ];
      rows.push(
        `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="5040"/><w:gridCol w:w="1440"/><w:gridCol w:w="1440"/><w:gridCol w:w="1440"/></w:tblGrid>${worksTable.join('')}</w:tbl>`,
      );
      rows.push(this.para(''));
    }

    // Parts table
    if (d.parts.length > 0) {
      rows.push(this.para('Запчастини та матеріали', true, 24));
      const partsTable = [
        this.tableRow(['Назва', 'Кількість', 'Од.', 'Ціна, ₴', 'Сума, ₴'], true, 'D9E1F2'),
        ...d.parts.map(p =>
          this.tableRow([p.name, String(p.quantity), p.unit, fmt(p.price), fmt(p.amount)]),
        ),
        this.tableRow(['', '', '', 'Разом запчастини:', fmt(d.totalParts)], true, 'DCE6F1'),
      ];
      rows.push(
        `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="4032"/><w:gridCol w:w="1440"/><w:gridCol w:w="648"/><w:gridCol w:w="1440"/><w:gridCol w:w="1800"/></w:tblGrid>${partsTable.join('')}</w:tbl>`,
      );
      rows.push(this.para(''));
    }

    // Grand total
    rows.push(
      `<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>ЗАГАЛЬНА СУМА: ${this.esc(fmt(d.totalAmount))} ₴</w:t></w:r></w:p>`,
    );

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${rows.join('\n    ')}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1134"/>
    </w:sectPr>
  </w:body>
</w:document>`;
  }

  private contentTypesXml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/package.core-properties+xml"/>
</Types>`;
  }

  private rootRelsXml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
  }

  private docRelsXml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>`;
  }

  private stylesXml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
</w:styles>`;
  }

  private settingsXml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:defaultTabStop w:val="720"/>
</w:settings>`;
  }

  private appXml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>STO ERP</Application>
</Properties>`;
  }

  private coreXml(number: string): string {
    const now = new Date().toISOString();
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Кошторис ${this.esc(number)}</dc:title>
  <dc:creator>STO ERP</dc:creator>
  <cp:created>${now}</cp:created>
</cp:coreProperties>`;
  }
}
