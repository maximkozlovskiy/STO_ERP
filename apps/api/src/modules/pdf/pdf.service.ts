import { Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PdfPrinter = require('pdfmake/build/pdfmake') as {
  new (fonts: Record<string, unknown>): {
    createPdfKitDocument(
      docDef: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): NodeJS.EventEmitter & { end(): void };
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vfsFonts = require('pdfmake/build/vfs_fonts') as { pdfMake?: { vfs?: Record<string, string> }; vfs?: Record<string, string> };

export interface OrgInfo {
  name: string;
  edrpou?: string | null;
  address?: string | null;
}

export interface CounterpartyInfo {
  name: string;
  phone?: string | null;
  edrpou?: string | null;
  address?: string | null;
}

export interface InvoicePdfData {
  org: OrgInfo;
  counterparty: CounterpartyInfo;
  number: string;
  date: Date;
  dueDate?: Date | null;
  lines: Array<{
    description: string;
    quantity: number;
    unit: string;
    unitPrice: number;
    vatRate: number;
    total: number;
  }>;
  subtotal: number;
  vatTotal: number;
  grandTotal: number;
}

export interface WorkOrderPdfData {
  org: OrgInfo;
  counterparty: CounterpartyInfo;
  vehicleLabel: string;
  number: string;
  date: Date;
  works: Array<{ name: string; quantity: number; price: number; total: number }>;
  parts: Array<{ name: string; quantity: number; price: number; total: number }>;
  total: number;
}

type Content = Record<string, unknown> | string | Content[];
type TableCell = string | Record<string, unknown>;

@Injectable()
export class PdfService {
  private printer: InstanceType<typeof PdfPrinter>;

  constructor() {
    const vfs = vfsFonts.pdfMake?.vfs ?? vfsFonts.vfs ?? {};
    const fonts = {
      Roboto: {
        normal: Buffer.from(vfs['Roboto-Regular.ttf'] ?? '', 'base64'),
        bold: Buffer.from(vfs['Roboto-Medium.ttf'] ?? '', 'base64'),
        italics: Buffer.from(vfs['Roboto-Italic.ttf'] ?? '', 'base64'),
        bolditalics: Buffer.from(vfs['Roboto-MediumItalic.ttf'] ?? '', 'base64'),
      },
    };
    this.printer = new PdfPrinter(fonts);
  }

  async generateInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
    const docDef = {
      content: [
        this.header(data.org, `Рахунок № ${data.number}`),
        { text: `Дата: ${this.fmtDate(data.date)}${data.dueDate ? `   Оплатити до: ${this.fmtDate(data.dueDate)}` : ''}`, margin: [0, 4, 0, 8] },
        this.partyBlock('Постачальник', data.org),
        this.partyBlock('Покупець', data.counterparty),
        { text: ' ', margin: [0, 4] },
        {
          table: {
            headerRows: 1,
            widths: ['*', 40, 50, 60, 40, 65],
            body: [
              [
                { text: 'Найменування', bold: true },
                { text: 'Кіл.', bold: true },
                { text: 'Од.', bold: true },
                { text: 'Ціна', bold: true },
                { text: 'ПДВ%', bold: true },
                { text: 'Сума', bold: true },
              ],
              ...data.lines.map((l): TableCell[] => [
                l.description,
                { text: String(l.quantity), alignment: 'right' },
                l.unit,
                { text: this.fmtMoney(l.unitPrice), alignment: 'right' },
                { text: `${l.vatRate}%`, alignment: 'right' },
                { text: this.fmtMoney(l.total), alignment: 'right' },
              ]),
            ],
          },
          layout: 'lightHorizontalLines',
        },
        { text: ' ', margin: [0, 4] },
        this.totalsBlock(data.subtotal, data.vatTotal, data.grandTotal),
        { text: '\n\nПідпис: _____________________', margin: [0, 32, 0, 0] },
      ],
      defaultStyle: { font: 'Roboto', fontSize: 10 },
      pageSize: 'A4',
      pageMargins: [40, 40, 40, 40],
    };
    return this.buildBuffer(docDef);
  }

  async generateWorkOrderPdf(data: WorkOrderPdfData): Promise<Buffer> {
    const docDef = {
      content: [
        this.header(data.org, `Наряд-замовлення № ${data.number}`),
        { text: `Дата: ${this.fmtDate(data.date)}`, margin: [0, 4, 0, 8] },
        this.partyBlock('Виконавець', data.org),
        this.partyBlock('Клієнт', data.counterparty),
        { text: `Автомобіль: ${data.vehicleLabel}`, margin: [0, 4, 0, 8] },
        ...(data.works.length > 0
          ? [{ text: 'Роботи:', bold: true, margin: [0, 8, 0, 4] }, this.itemsTable(data.works)]
          : []),
        ...(data.parts.length > 0
          ? [{ text: 'Запчастини:', bold: true, margin: [0, 8, 0, 4] }, this.itemsTable(data.parts)]
          : []),
        { text: ' ', margin: [0, 4] },
        { columns: [{ width: '*', text: '' }, { width: 200, stack: [{ text: `Разом: ${this.fmtMoney(data.total)}`, bold: true, fontSize: 11 }] }] },
        { text: '\n\nПідпис клієнта: _____________________     Підпис виконавця: _____________________', margin: [0, 32, 0, 0] },
      ],
      defaultStyle: { font: 'Roboto', fontSize: 10 },
      pageSize: 'A4',
      pageMargins: [40, 40, 40, 40],
    };
    return this.buildBuffer(docDef);
  }

  private header(org: OrgInfo, title: string): Content {
    return {
      columns: [
        { width: '*', stack: [{ text: org.name, bold: true, fontSize: 14 }, ...(org.edrpou ? [{ text: `ЄДРПОУ: ${org.edrpou}`, fontSize: 9 }] : [])] },
        { width: 'auto', text: title, bold: true, fontSize: 14, alignment: 'right' },
      ],
      margin: [0, 0, 0, 8],
    };
  }

  private partyBlock(label: string, party: { name: string; edrpou?: string | null; address?: string | null; phone?: string | null }): Content {
    return {
      stack: [
        { text: `${label}:`, bold: true, fontSize: 9 },
        { text: party.name, fontSize: 10 },
        ...(party.edrpou ? [{ text: `ЄДРПОУ: ${party.edrpou}`, fontSize: 9 }] : []),
        ...(party.address ? [{ text: party.address, fontSize: 9 }] : []),
        ...(party.phone ? [{ text: `Тел: ${party.phone}`, fontSize: 9 }] : []),
      ],
      margin: [0, 2, 0, 2],
    };
  }

  private totalsBlock(subtotal: number, vatTotal: number, grandTotal: number): Content {
    return {
      columns: [
        { width: '*', text: '' },
        {
          width: 200,
          stack: [
            { columns: [{ text: 'Сума без ПДВ:', width: '*' }, { text: this.fmtMoney(subtotal), width: 80, alignment: 'right' }] },
            { columns: [{ text: 'ПДВ:', width: '*' }, { text: this.fmtMoney(vatTotal), width: 80, alignment: 'right' }] },
            { columns: [{ text: 'Разом:', bold: true, width: '*' }, { text: this.fmtMoney(grandTotal), bold: true, width: 80, alignment: 'right' }] },
          ],
        },
      ],
    };
  }

  private itemsTable(rows: Array<{ name: string; quantity: number; price: number; total: number }>): Content {
    return {
      table: {
        headerRows: 1,
        widths: ['*', 50, 65, 70],
        body: [
          [
            { text: 'Найменування', bold: true },
            { text: 'Кіл.', bold: true },
            { text: 'Ціна', bold: true },
            { text: 'Сума', bold: true },
          ],
          ...rows.map((r): TableCell[] => [
            r.name,
            { text: String(r.quantity), alignment: 'right' },
            { text: this.fmtMoney(r.price), alignment: 'right' },
            { text: this.fmtMoney(r.total), alignment: 'right' },
          ]),
        ],
      },
      layout: 'lightHorizontalLines',
    };
  }

  private fmtMoney(n: number): string {
    return new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + ' ₴';
  }

  private fmtDate(d: Date): string {
    return d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  private buildBuffer(docDef: Record<string, unknown>): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const pdfDoc = this.printer.createPdfKitDocument(docDef);
      pdfDoc.on('data', (chunk: Buffer) => chunks.push(chunk));
      pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
      pdfDoc.on('error', reject);
      pdfDoc.end();
    });
  }
}
