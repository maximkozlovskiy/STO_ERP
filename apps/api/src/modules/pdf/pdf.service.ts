import { Injectable, Logger } from '@nestjs/common';
import { resolve } from 'path';
import { SETTLEMENT_TX_TYPE_LABELS } from '@sto/shared';
// pdfmake v0.3.x server-side API: singleton instance with createPdf(docDef).getBuffer().
// The legacy `pdfmake/build/pdfmake` path is a browser-only UMD bundle and has no PdfPrinter class.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfMake = require('pdfmake') as {
  setFonts(fonts: Record<string, unknown>): void;
  setUrlAccessPolicy?(callback: (url: string) => boolean): void;
  setLocalAccessPolicy?(callback: (path: string) => boolean): void;
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
// Кількість і години — у тому ж українському форматі, що й суми («1,5», не «1.5»; Bug #866).
const UA_QTY_FMT = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 3 });
const UA_DATE_FMT = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/**
 * Реквізити організації для шапки друкованого документа (`OrgPrintInfoService.get`).
 * Усе, крім назви, необов'язкове: незаповнене в НДІ просто не друкується.
 */
export interface OrgPrintInfo {
  name: string;
  edrpou?: string | null;
  /** ІПН платника ПДВ. */
  ipn?: string | null;
  /** Фактична адреса, інакше юридична. */
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  /** Логотип як data URL (PNG/JPEG) — лише перевірений `OrgPrintInfoService`. */
  logo?: string | null;
  /** Основний банківський рахунок організації (НДІ → «Реквізити»). */
  bank?: {
    iban: string;
    bankName?: string | null;
    mfo?: string | null;
    /** ЄДРПОУ одержувача на рахунку, якщо відрізняється від ЄДРПОУ організації. */
    edrpou?: string | null;
  } | null;
}

/** Ключ логотипа в `docDefinition.images` — сам рядок data URL в `image:` не підставляємо. */
const LOGO_IMAGE_KEY = 'orgLogo';
/** Нерозривний пробіл: усередині реквізиту шапки рядок не переноситься (Bug #867). */
const NBSP = String.fromCharCode(0xa0);

export interface CounterpartyInfo {
  name: string;
  phone?: string | null;
  edrpou?: string | null;
  address?: string | null;
}

export interface InvoicePdfData {
  org: OrgPrintInfo;
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
  /** Валюта рахунку (ISO-код); без неї — гривня. */
  currencyCode?: string | null;
}

export interface ReconciliationActPdfData {
  org: OrgPrintInfo;
  counterpartyName: string;
  periodFrom: Date;
  periodTo: Date;
  openingBalance: number;
  closingBalance: number;
  transactions: Array<{ date: Date; type: string; amount: number; documentType?: string }>;
}

export interface CompletionActPdfData {
  org: OrgPrintInfo;
  counterparty: CounterpartyInfo;
  vehicleLabel: string;
  number: string;
  date: Date;
  signedAt?: Date | null;
  signedBy?: string | null;
  lines: Array<{ description: string; quantity: number; unitPrice: number; amount: number }>;
  /** Сума до сплати (з ПДВ, якщо він є). */
  total: number;
  /** Сума без ПДВ і ПДВ — задані, коли в сумі є ПДВ: тоді підсумок друкується трьома рядками. */
  totalNet?: number;
  vatTotal?: number;
  notes?: string | null;
  /** Валюта наряду акта (ISO-код); без неї — гривня. */
  currencyCode?: string | null;
}

export interface WorkOrderPdfData {
  org: OrgPrintInfo;
  counterparty: CounterpartyInfo;
  vehicleLabel: string;
  vin?: string | null;
  /** Пробіг на момент прийому авто, км. */
  mileage?: number | null;
  number: string;
  /** Дата документа наряду (`documentDate`), не дата створення запису. */
  date: Date;
  /**
   * Роботи: `quantity` — години, за які взято гроші (факт, інакше норма), `total` — сума рядка.
   * `normoHours` / `actualHours` друкуються окремими колонками.
   */
  works: Array<{
    name: string;
    quantity: number;
    normoHours?: number | null;
    actualHours?: number | null;
    price: number;
    total: number;
  }>;
  parts: Array<{ name: string; quantity: number; unit?: string; price: number; total: number }>;
  /** Сума до сплати (з ПДВ, якщо він є). */
  total: number;
  /** Сума без ПДВ і ПДВ — задані, коли в сумі є ПДВ: тоді підсумок друкується трьома рядками. */
  totalNet?: number;
  vatTotal?: number;
  /** Валюта наряду (ISO-код); без неї — гривня. */
  currencyCode?: string | null;
}

type Content = Record<string, unknown> | string | Content[];
type TableCell = string | Record<string, unknown>;
type DocDefinition = Record<string, unknown>;

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);

  constructor() {
    // Register Roboto family once at module-init using the on-disk file paths. We fail fast
    // here (rather than at first PDF request) if pdfmake/fonts/Roboto was somehow not
    // installed — the boot-time error message is much clearer than the URLResolver crash.
    if (!robotoFontDescriptor.Roboto?.normal) {
      throw new Error('pdfmake Roboto descriptor missing. Re-install @sto/api dependencies.');
    }
    pdfMake.setFonts(robotoFontDescriptor);
    // Шапка несе зображення, тож закриваємо pdfmake доступ до ресурсів: з мережі — нічого
    // (рядок у `image` pdfmake інакше завантажив би як URL), з диска — лише файли шрифтів Roboto.
    // Логотип приходить data URL-ом від OrgPrintInfoService і під ці політики не підпадає.
    const fontFiles = new Set(Object.values(robotoFontDescriptor.Roboto).map(f => resolve(f)));
    pdfMake.setUrlAccessPolicy?.(() => false);
    pdfMake.setLocalAccessPolicy?.(file => fontFiles.has(resolve(file)));
  }

  async generateInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
    return this.render(data.org, org => ({
      ...this.page(org),
      content: [
        this.header(org, `Рахунок № ${data.number}`),
        {
          text: `Дата: ${this.fmtDate(data.date)}${data.dueDate ? `   Оплатити до: ${this.fmtDate(data.dueDate)}` : ''}`,
          margin: [0, 4, 0, 8],
        },
        this.partyBlock('Постачальник', org),
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
                { text: this.fmtQty(l.quantity), alignment: 'right' },
                l.unit,
                { text: this.fmtMoney(l.unitPrice, data.currencyCode), alignment: 'right' },
                { text: `${l.vatRate}%`, alignment: 'right' },
                { text: this.fmtMoney(l.total, data.currencyCode), alignment: 'right' },
              ]),
            ],
          },
          layout: 'lightHorizontalLines',
        },
        { text: ' ', margin: [0, 4] },
        this.totalsBlock(data.subtotal, data.vatTotal, data.grandTotal, data.currencyCode),
        ...this.paymentDetails(org),
        { text: '\n\nПідпис: _____________________', margin: [0, 32, 0, 0] },
      ],
    }));
  }

  async generateReconciliationActPdf(data: ReconciliationActPdfData): Promise<Buffer> {
    // Раніше — локальний дубль лише на 5 клієнтських типів (без SUPPLIER_*/FX_GAIN/FX_LOSS) →
    // курсова різниця (мультивалюта Фаза 4) друкувалась у акті як сирий enum 'FX_GAIN'/'FX_LOSS'.
    // Тепер єдине джерело — shared SETTLEMENT_TX_TYPE_LABELS (дзеркалить settlements екрани).
    const txTypeLabel = (type: string) => SETTLEMENT_TX_TYPE_LABELS[type] ?? type;

    return this.render(data.org, org => ({
      ...this.page(org),
      content: [
        this.header(org, 'Акт звірки'),
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
    }));
  }

  async generateCompletionActPdf(data: CompletionActPdfData): Promise<Buffer> {
    return this.render(data.org, org => ({
      ...this.page(org),
      content: [
        this.header(org, `Акт виконаних робіт № ${data.number}`),
        {
          text: `Дата: ${this.fmtDate(data.date)}${data.signedAt ? `   Підписано: ${this.fmtDate(data.signedAt)}` : ''}`,
          margin: [0, 4, 0, 8],
        },
        this.partyBlock('Виконавець', org),
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
                { text: this.fmtQty(l.quantity), alignment: 'right' },
                { text: this.fmtMoney(l.unitPrice, data.currencyCode), alignment: 'right' },
                { text: this.fmtMoney(l.amount, data.currencyCode), alignment: 'right' },
              ]),
            ],
          },
          layout: 'lightHorizontalLines',
        },
        { text: ' ', margin: [0, 4] },
        this.documentTotal(data),
        ...(data.notes
          ? [{ text: `Примітки: ${data.notes}`, margin: [0, 8, 0, 0], fontSize: 9 }]
          : []),
        ...(data.signedBy ? [{ text: `Підписав: ${data.signedBy}`, margin: [0, 8, 0, 0] }] : []),
        {
          text: '\n\nПідпис замовника: _____________________     Підпис виконавця: _____________________',
          margin: [0, 32, 0, 0],
        },
      ],
    }));
  }

  async generateWorkOrderPdf(data: WorkOrderPdfData): Promise<Buffer> {
    const vehicle = [
      data.vehicleLabel,
      data.vin ? `VIN: ${data.vin}` : '',
      data.mileage != null ? `пробіг: ${data.mileage} км` : '',
    ].filter(Boolean);
    return this.render(data.org, org => ({
      ...this.page(org),
      content: [
        this.header(org, `Наряд-замовлення № ${data.number}`),
        { text: `Дата: ${this.fmtDate(data.date)}`, margin: [0, 4, 0, 8] },
        this.partyBlock('Виконавець', org),
        this.partyBlock('Клієнт', data.counterparty),
        { text: `Автомобіль: ${vehicle.join(', ')}`, margin: [0, 4, 0, 8] },
        ...(data.works.length > 0
          ? [
              { text: 'Роботи:', bold: true, margin: [0, 8, 0, 4] },
              this.worksTable(data.works, data.currencyCode),
            ]
          : []),
        ...(data.parts.length > 0
          ? [
              { text: 'Товари:', bold: true, margin: [0, 8, 0, 4] },
              this.partsTable(data.parts, data.currencyCode),
            ]
          : []),
        { text: ' ', margin: [0, 4] },
        this.documentTotal(data),
        {
          text: '\n\nПідпис клієнта: _____________________     Підпис виконавця: _____________________',
          margin: [0, 32, 0, 0],
        },
      ],
    }));
  }

  /** Спільні параметри сторінки; логотип реєструється в `images` лише коли він є. */
  private page(org: OrgPrintInfo): DocDefinition {
    return {
      defaultStyle: { font: 'Roboto', fontSize: 10 },
      pageSize: 'A4',
      pageMargins: [40, 40, 40, 40],
      ...(org.logo ? { images: { [LOGO_IMAGE_KEY]: org.logo } } : {}),
    };
  }

  /**
   * Чи прийме pdfmake зображення (data URL): будує крихітний документ лише з ним. Кличе
   * `OrgPrintInfoService` перед тим, як покласти логотип у кеш на добу — пошкоджений файл із
   * правильною сигнатурою інакше змушував би кожен друк будувати PDF двічі (`render`).
   */
  async probeImage(dataUrl: string): Promise<boolean> {
    try {
      await this.buildBuffer({
        defaultStyle: { font: 'Roboto' },
        images: { [LOGO_IMAGE_KEY]: dataUrl },
        content: [{ image: LOGO_IMAGE_KEY, fit: [16, 16] }],
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Будує документ; якщо pdfmake не прийняв логотип (пошкоджене зображення з правильною
   * сигнатурою) — будує ще раз без логотипа. Документ друкується завжди.
   */
  private async render(
    org: OrgPrintInfo,
    build: (org: OrgPrintInfo) => DocDefinition,
  ): Promise<Buffer> {
    if (!org.logo) return this.buildBuffer(build(org));
    try {
      return await this.buildBuffer(build(org));
    } catch (e: unknown) {
      this.logger.warn(
        `PDF logo rejected by renderer, printing without it: ${e instanceof Error ? e.message : String(e)}`,
      );
      return this.buildBuffer(build({ ...org, logo: null }));
    }
  }

  /**
   * Шапка документа: логотип ліворуч, назва й реквізити організації поруч, назва документа
   * праворуч. Однакова в наряді, рахунку, акті виконаних робіт і акті звірки.
   */
  private header(org: OrgPrintInfo, title: string): Content {
    // Усередині реквізиту — нерозривні пробіли: рядок переноситься лише МІЖ реквізитами, а не
    // посеред «Банк: АТ Банк» чи «МФО: 322313» (Bug #867).
    const join = (parts: Array<string | null | undefined | false>) =>
      parts
        .filter((p): p is string => !!p)
        .map(p => p.replace(/ /g, NBSP))
        .join('   ');
    const lines = [
      join([org.edrpou && `ЄДРПОУ: ${org.edrpou}`, org.ipn && `ІПН: ${org.ipn}`]),
      org.address ?? '',
      join([org.phone && `Тел.: ${org.phone}`, org.email && `E-mail: ${org.email}`]),
      org.bank
        ? join([
            `IBAN: ${org.bank.iban}`,
            org.bank.bankName && `Банк: ${org.bank.bankName}`,
            org.bank.mfo && `МФО: ${org.bank.mfo}`,
          ])
        : '',
    ].filter(Boolean);
    return {
      columns: [
        ...(org.logo ? [{ width: 90, image: LOGO_IMAGE_KEY, fit: [90, 60] }] : []),
        {
          width: '*',
          stack: [
            { text: org.name, bold: true, fontSize: 13 },
            ...lines.map(text => ({ text, fontSize: 8 })),
          ],
        },
        { width: 'auto', text: title, bold: true, fontSize: 13, alignment: 'right' },
      ],
      columnGap: 10,
      margin: [0, 0, 0, 8],
    };
  }

  /**
   * «Реквізити для оплати» рахунку — лише коли в НДІ задано основний банківський рахунок.
   * Без рахунку блок не друкується (порожнього «IBAN:» у рахунку не буває).
   */
  private paymentDetails(org: OrgPrintInfo): Content[] {
    if (!org.bank) return [];
    const recipientEdrpou = org.bank.edrpou || org.edrpou;
    return [
      {
        stack: [
          { text: 'Реквізити для оплати:', bold: true, fontSize: 9 },
          { text: `Одержувач: ${org.name}`, fontSize: 9 },
          ...(recipientEdrpou ? [{ text: `ЄДРПОУ: ${recipientEdrpou}`, fontSize: 9 }] : []),
          { text: `IBAN: ${org.bank.iban}`, fontSize: 9 },
          ...(org.bank.bankName ? [{ text: `Банк: ${org.bank.bankName}`, fontSize: 9 }] : []),
          ...(org.bank.mfo ? [{ text: `МФО: ${org.bank.mfo}`, fontSize: 9 }] : []),
        ],
        margin: [0, 12, 0, 0],
      },
    ];
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

  /**
   * Підсумок наряду й акта: коли в сумі є ПДВ — «Сума без ПДВ / ПДВ / Разом» (той самий блок,
   * що в рахунку), інакше один рядок «Разом». Клієнт бачить ту саму суму, що в його боргу.
   */
  private documentTotal(data: {
    total: number;
    totalNet?: number;
    vatTotal?: number;
    currencyCode?: string | null;
  }): Content {
    if (data.vatTotal && data.vatTotal > 0 && data.totalNet != null)
      return this.totalsBlock(data.totalNet, data.vatTotal, data.total, data.currencyCode);
    return {
      columns: [
        { width: '*', text: '' },
        {
          width: 200,
          stack: [
            {
              text: `Разом: ${this.fmtMoney(data.total, data.currencyCode)}`,
              bold: true,
              fontSize: 11,
            },
          ],
        },
      ],
    };
  }

  private totalsBlock(
    subtotal: number,
    vatTotal: number,
    grandTotal: number,
    currencyCode?: string | null,
  ): Content {
    return {
      columns: [
        { width: '*', text: '' },
        {
          width: 200,
          stack: [
            {
              columns: [
                { text: 'Сума без ПДВ:', width: '*' },
                { text: this.fmtMoney(subtotal, currencyCode), width: 80, alignment: 'right' },
              ],
            },
            {
              columns: [
                { text: 'ПДВ:', width: '*' },
                { text: this.fmtMoney(vatTotal, currencyCode), width: 80, alignment: 'right' },
              ],
            },
            {
              columns: [
                { text: 'Разом:', bold: true, width: '*' },
                {
                  text: this.fmtMoney(grandTotal, currencyCode),
                  bold: true,
                  width: 80,
                  alignment: 'right',
                },
              ],
            },
          ],
        },
      ],
    };
  }

  /** Роботи наряду: норма й факт годин окремо, ціна за годину, сума рядка. */
  private worksTable(rows: WorkOrderPdfData['works'], currencyCode?: string | null): Content {
    const hours = (h: number | null | undefined): TableCell => ({
      text: h == null ? '—' : this.fmtQty(h),
      alignment: 'right',
    });
    return {
      table: {
        headerRows: 1,
        widths: ['*', 50, 50, 65, 70],
        body: [
          [
            { text: 'Найменування', bold: true },
            { text: 'Норма, год', bold: true },
            { text: 'Факт, год', bold: true },
            { text: 'Ціна', bold: true },
            { text: 'Сума', bold: true },
          ],
          ...rows.map((r): TableCell[] => [
            r.name,
            hours(r.normoHours === undefined ? r.quantity : r.normoHours),
            hours(r.actualHours),
            { text: this.fmtMoney(r.price, currencyCode), alignment: 'right' },
            { text: this.fmtMoney(r.total, currencyCode), alignment: 'right' },
          ]),
        ],
      },
      layout: 'lightHorizontalLines',
    };
  }

  /** Товари наряду: кількість з одиницею виміру, ціна, сума рядка. */
  private partsTable(rows: WorkOrderPdfData['parts'], currencyCode?: string | null): Content {
    return {
      table: {
        headerRows: 1,
        widths: ['*', 45, 35, 65, 70],
        body: [
          [
            { text: 'Найменування', bold: true },
            { text: 'Кіл.', bold: true },
            { text: 'Од.', bold: true },
            { text: 'Ціна', bold: true },
            { text: 'Сума', bold: true },
          ],
          ...rows.map((r): TableCell[] => [
            r.name,
            { text: this.fmtQty(r.quantity), alignment: 'right' },
            r.unit || 'шт',
            { text: this.fmtMoney(r.price, currencyCode), alignment: 'right' },
            { text: this.fmtMoney(r.total, currencyCode), alignment: 'right' },
          ]),
        ],
      },
      layout: 'lightHorizontalLines',
    };
  }

  // «грн», а не «₴»: у вбудованому шрифті Roboto знаку гривні немає — на папері він друкувався
  // порожнім квадратом. Формат суми — як в інтерфейсі: «1 250,00 грн». Документ в іншій валюті
  // (рахунок чи наряд у USD) — з кодом валюти, як у web (`fmtBankCurrencySuffix`): «100,00 USD».
  private fmtMoney(n: number, currencyCode?: string | null): string {
    const suffix = !currencyCode || currencyCode === 'UAH' ? 'грн' : currencyCode;
    return `${UAH_FMT.format(n)} ${suffix}`;
  }

  private fmtQty(n: number): string {
    return UA_QTY_FMT.format(n);
  }

  private fmtDate(d: Date): string {
    return UA_DATE_FMT.format(d);
  }

  private buildBuffer(docDef: DocDefinition): Promise<Buffer> {
    // pdfmake v0.3.x: createPdf().getBuffer() handles the readable stream internally
    // and returns a Promise<Buffer>. We no longer need to wire up readable/end/error events.
    return pdfMake.createPdf(docDef).getBuffer();
  }
}
