import { Injectable } from '@nestjs/common';
// pdfmake v0.3.x server-side API: singleton instance with createPdf(docDef).getBuffer().
// The legacy `pdfmake/build/pdfmake` path is a browser-only UMD bundle and has no PdfPrinter class.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfMake = require('pdfmake') as {
  setFonts(fonts: Record<string, unknown>): void;
  createPdf(
    docDef: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): {
    getBuffer(): Promise<Buffer>;
  };
};
// pdfmake v0.3.x server-side font handling: the printer's URLResolver expects each font
// descriptor to be a STRING path (or URL), not a Buffer. Passing Buffers makes pdfmake call
// `(buf).url.toLowerCase()` inside resolveUrls and crash with "Cannot read properties of
// undefined (reading 'toLowerCase')".
// pdfmake ships the Roboto family on disk under `pdfmake/fonts/Roboto/*.ttf` together with
// a ready-to-use descriptor at `pdfmake/fonts/Roboto` — using that descriptor wires the file
// paths in one line and is the canonical server-side recipe.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const robotoFontDescriptor = require('pdfmake/fonts/Roboto') as {
  Roboto: { normal: string; bold: string; italics: string; bolditalics: string };
};

// Module-level Intl singletons — locale-data init coштує найбільше у форматерах.
// Hot path: fmtMoney/fmtDate викликаються у .map() для кожного рядка таблиці PDF
// (накладна на 20-50 рядків → 40-100 конструкцій форматера на документ).
const UAH_FMT = new Intl.NumberFormat('uk-UA', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const UA_DATE_FMT = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

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

export interface ReconciliationActPdfData {
  org: OrgInfo;
  counterpartyName: string;
  periodFrom: Date;
  periodTo: Date;
  openingBalance: number;
  closingBalance: number;
  transactions: Array<{ date: Date; type: string; amount: number; documentType?: string }>;
}

export interface CompletionActPdfData {
  org: OrgInfo;
  counterparty: CounterpartyInfo;
  vehicleLabel: string;
  number: string;
  date: Date;
  signedAt?: Date | null;
  signedBy?: string | null;
  lines: Array<{ description: string; quantity: number; unitPrice: number; amount: number }>;
  total: number;
  notes?: string | null;
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
  constructor() {
    // Register Roboto family once at module-init using the on-disk file paths. We fail fast
    // here (rather than at first PDF request) if pdfmake/fonts/Roboto was somehow not
    // installed — the boot-time error message is much clearer than the URLResolver crash.
    if (!robotoFontDescriptor.Roboto?.normal) {
      throw new Error('pdfmake Roboto descriptor missing. Re-install @sto/api dependencies.');
    }
    pdfMake.setFonts(robotoFontDescriptor);
  }

  async generateInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
    const docDef = {
      content: [
        this.header(data.org, `Рахунок № ${data.number}`),
        {
          text: `Дата: ${this.fmtDate(data.date)}${data.dueDate ? `   Оплатити до: ${this.fmtDate(data.dueDate)}` : ''}`,
          margin: [0, 4, 0, 8],
        },
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

  async generateReconciliationActPdf(data: ReconciliationActPdfData): Promise<Buffer> {
    const txTypeLabel = (type: string) =>
      ({
        CHARGE: 'Нарахування',
        PAYMENT: 'Оплата',
        PREPAYMENT: 'Передоплата',
        REFUND: 'Повернення',
        CREDIT_NOTE: 'Кредит-нота',
      })[type] ?? type;

    const docDef = {
      content: [
        this.header(data.org, 'Акт звірки'),
        { text: `Контрагент: ${data.counterpartyName}`, margin: [0, 4, 0, 2] },
        {
          text: `Період: ${this.fmtDate(data.periodFrom)} — ${this.fmtDate(data.periodTo)}`,
          margin: [0, 0, 0, 8],
        },
        { text: `Початковий залишок: ${this.fmtMoney(data.openingBalance)}`, margin: [0, 2, 0, 2] },
        {
          table: {
            headerRows: 1,
            widths: ['auto', '*', 'auto', 80],
            body: [
              [
                { text: 'Дата', bold: true },
                { text: 'Тип', bold: true },
                { text: 'Документ', bold: true },
                { text: 'Сума', bold: true, alignment: 'right' },
              ],
              ...data.transactions.map((t): TableCell[] => [
                this.fmtDate(new Date(t.date)),
                txTypeLabel(t.type),
                t.documentType ?? '',
                { text: this.fmtMoney(t.amount), alignment: 'right' },
              ]),
            ],
          },
          layout: 'lightHorizontalLines',
          margin: [0, 4, 0, 8],
        },
        {
          text: `Кінцевий залишок: ${this.fmtMoney(data.closingBalance)}`,
          bold: true,
          margin: [0, 4, 0, 0],
        },
        {
          text: '\n\nПідпис (виконавець): _____________________     Підпис (контрагент): _____________________',
          margin: [0, 40, 0, 0],
        },
      ],
      defaultStyle: { font: 'Roboto', fontSize: 10 },
      pageSize: 'A4',
      pageMargins: [40, 40, 40, 40],
    };
    return this.buildBuffer(docDef);
  }

  async generateCompletionActPdf(data: CompletionActPdfData): Promise<Buffer> {
    const docDef = {
      content: [
        this.header(data.org, `Акт виконаних робіт № ${data.number}`),
        {
          text: `Дата: ${this.fmtDate(data.date)}${data.signedAt ? `   Підписано: ${this.fmtDate(data.signedAt)}` : ''}`,
          margin: [0, 4, 0, 8],
        },
        this.partyBlock('Виконавець', data.org),
        this.partyBlock('Замовник', data.counterparty),
        { text: `Автомобіль: ${data.vehicleLabel}`, margin: [0, 4, 0, 8] },
        {
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
              ...data.lines.map((l): TableCell[] => [
                l.description,
                { text: String(l.quantity), alignment: 'right' },
                { text: this.fmtMoney(l.unitPrice), alignment: 'right' },
                { text: this.fmtMoney(l.amount), alignment: 'right' },
              ]),
            ],
          },
          layout: 'lightHorizontalLines',
        },
        { text: ' ', margin: [0, 4] },
        {
          columns: [
            { width: '*', text: '' },
            {
              width: 200,
              stack: [{ text: `Разом: ${this.fmtMoney(data.total)}`, bold: true, fontSize: 11 }],
            },
          ],
        },
        ...(data.notes
          ? [{ text: `Примітки: ${data.notes}`, margin: [0, 8, 0, 0], fontSize: 9 }]
          : []),
        ...(data.signedBy ? [{ text: `Підписав: ${data.signedBy}`, margin: [0, 8, 0, 0] }] : []),
        {
          text: '\n\nПідпис замовника: _____________________     Підпис виконавця: _____________________',
          margin: [0, 32, 0, 0],
        },
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
        {
          columns: [
            { width: '*', text: '' },
            {
              width: 200,
              stack: [{ text: `Разом: ${this.fmtMoney(data.total)}`, bold: true, fontSize: 11 }],
            },
          ],
        },
        {
          text: '\n\nПідпис клієнта: _____________________     Підпис виконавця: _____________________',
          margin: [0, 32, 0, 0],
        },
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
        {
          width: '*',
          stack: [
            { text: org.name, bold: true, fontSize: 14 },
            ...(org.edrpou ? [{ text: `ЄДРПОУ: ${org.edrpou}`, fontSize: 9 }] : []),
          ],
        },
        { width: 'auto', text: title, bold: true, fontSize: 14, alignment: 'right' },
      ],
      margin: [0, 0, 0, 8],
    };
  }

  private partyBlock(
    label: string,
    party: { name: string; edrpou?: string | null; address?: string | null; phone?: string | null },
  ): Content {
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
            {
              columns: [
                { text: 'Сума без ПДВ:', width: '*' },
                { text: this.fmtMoney(subtotal), width: 80, alignment: 'right' },
              ],
            },
            {
              columns: [
                { text: 'ПДВ:', width: '*' },
                { text: this.fmtMoney(vatTotal), width: 80, alignment: 'right' },
              ],
            },
            {
              columns: [
                { text: 'Разом:', bold: true, width: '*' },
                { text: this.fmtMoney(grandTotal), bold: true, width: 80, alignment: 'right' },
              ],
            },
          ],
        },
      ],
    };
  }

  private itemsTable(
    rows: Array<{ name: string; quantity: number; price: number; total: number }>,
  ): Content {
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
    return UAH_FMT.format(n) + ' ₴';
  }

  private fmtDate(d: Date): string {
    return UA_DATE_FMT.format(d);
  }

  private buildBuffer(docDef: Record<string, unknown>): Promise<Buffer> {
    // pdfmake v0.3.x: createPdf().getBuffer() handles the readable stream internally
    // and returns a Promise<Buffer>. We no longer need to wire up readable/end/error events.
    return pdfMake.createPdf(docDef).getBuffer();
  }
}
