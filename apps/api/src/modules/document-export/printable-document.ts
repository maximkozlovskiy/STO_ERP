import { BadRequestException } from '@nestjs/common';
import { formatPersonName } from '@sto/shared';
import type { OrgPrintInfo } from '../pdf/org-print-info.types';
import { safeFilenamePart } from '../../common/http/send-file';
import { err } from '../../common/utils/err';

/**
 * Друкований документ (рахунок, замовлення постачальнику, складський документ, повернення) —
 * одна нейтральна модель для трьох форматів: PDF (`PdfService.generateDocumentPdf`), XLSX і DOCX
 * (`document-*.renderer.ts`). Мапер документа (`*-printable.ts`) збирає її з бази, рендерер лише
 * розкладає на сторінку — тож у трьох файлах ті самі рядки, суми й підписи (BR-INV-028,
 * BR-PO-016, BR-SDOC-009, BR-SRET-014).
 */

export const EXPORT_FORMATS = ['pdf', 'xlsx', 'docx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Формат із адреси; інший — 400 українською (перелік допустимих у тексті). */
export function parseExportFormat(raw: string): ExportFormat {
  const fmt = (EXPORT_FORMATS as readonly string[]).find(f => f === raw);
  if (!fmt)
    throw new BadRequestException(
      err('err.documentExport.unknownFormat', {
        format: raw.slice(0, 20),
        allowed: EXPORT_FORMATS.join(', '),
      }),
    );
  return fmt as ExportFormat;
}

/** text — ліворуч; qty і money — праворуч, у XLSX числом із форматом. */
export type PrintableColumnKind = 'text' | 'qty' | 'money';

export interface PrintableColumn {
  label: string;
  kind: PrintableColumnKind;
}

/** Комірка: текст для `text`, число для `qty`/`money`; `null` — порожня (рядок без ціни). */
export type PrintableCell = string | number | null;

export interface PrintableTotal {
  label: string;
  value: number;
  /** Підсумковий рядок («До сплати», «Разом») — жирним. */
  strong?: boolean;
}

/** Блок сторони документа: «Платник», «Постачальник» — назва й реквізити рядками. */
export interface PrintableParty {
  label: string;
  lines: string[];
}

export interface PrintableField {
  label: string;
  value: string;
}

export interface PrintableDocument {
  /** Назва документа без номера: «Рахунок», «Замовлення постачальнику», «Списання». */
  title: string;
  number: string;
  /** Дата документа, готова до друку (дд.мм.рррр). */
  date: string;
  /** Позначений на видалення — друкується з позначкою «ВИДАЛЕНО» (TECH-DEBT (б) №24). */
  deleted: boolean;
  /** Валюта сум (ISO); без неї — гривня. */
  currencyCode: string | null;
  /**
   * Організація як сторона документа (рахунок — «Постачальник»): блок з її назвою й реквізитами
   * ставить `DocumentExportService` перед `parties`, бо реквізити мапер не читає.
   */
  orgParty?: string;
  parties: PrintableParty[];
  /** Решта реквізитів шапки: склад, договір, дата оплати… */
  fields: PrintableField[];
  columns: PrintableColumn[];
  rows: PrintableCell[][];
  totals: PrintableTotal[];
  notes: string | null;
  /** Ім'я файла без розширення: `Рахунок-INV-0001`. */
  filenameBase: string;
}

/** Позначка видаленого документа — однакова в трьох форматах. */
export const DELETED_MARK = 'ВИДАЛЕНО';

/** Ім'я файла документа: `<Тип>-<номер>`, символи `/\:*?"<>|` у номері → `-`. */
export function printableFilenameBase(prefix: string, number: string): string {
  return `${prefix}-${safeFilenamePart(number)}`;
}

/** Суфікс суми: «грн» для гривні (у шрифті PDF знаку ₴ немає), інакше ISO-код валюти. */
export function currencySuffix(currencyCode?: string | null): string {
  return !currencyCode || currencyCode === 'UAH' ? 'грн' : currencyCode;
}

const MONEY_FMT = new Intl.NumberFormat('uk-UA', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const QTY_FMT = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 3 });
// Дата без часу (`@db.Date`) зберігається північчю UTC — форматуємо в UTC, інакше в поясі з
// від'ємним зсувом це був би попередній день. Мітки часу (проведення, термін оплати) — за Києвом.
const DATE_ONLY_FMT = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});
const KYIV_DATE_FMT = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'Europe/Kyiv',
});

export const fmtPrintMoney = (n: number): string => MONEY_FMT.format(n);
export const fmtPrintQty = (n: number): string => QTY_FMT.format(n);
/** Календарна дата (`@db.Date`). */
export const fmtDateOnly = (d: Date): string => DATE_ONLY_FMT.format(d);
/** Мітка часу — дата за Києвом. */
export const fmtKyivDate = (d: Date): string => KYIV_DATE_FMT.format(d);

/** Текст комірки для PDF/DOCX: числа — українським форматом, `null` — порожньо. */
export function cellText(kind: PrintableColumnKind, v: PrintableCell): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return kind === 'money' ? fmtPrintMoney(v) : fmtPrintQty(v);
}

/** Підпис колонки сум із валютою: «Ціна, грн». */
export function columnLabel(col: PrintableColumn, currencyCode: string | null): string {
  return col.kind === 'money' ? `${col.label}, ${currencySuffix(currencyCode)}` : col.label;
}

/**
 * Реквізити організації рядками для шапки XLSX/DOCX — ті самі, що в шапці PDF
 * (`PdfService.header`): ЄДРПОУ й ІПН, адреса, телефон і e-mail, банківський рахунок.
 * `part` — перетворення окремого реквізиту (PDF ставить нерозривні пробіли всередині, Bug #867).
 */
export function orgDetailLines(org: OrgPrintInfo, part: (s: string) => string = s => s): string[] {
  const join = (parts: Array<string | null | undefined | false>) =>
    parts
      .filter((p): p is string => !!p)
      .map(part)
      .join('   ');
  return [
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
}

/** Поля контрагента для блоку сторони документа (`counterpartyParty`). */
export const PRINT_PARTY_SELECT = {
  firstName: true,
  lastName: true,
  companyName: true,
  phone: true,
  edrpou: true,
} as const;

/** Поля рядка для назви й одиниці (`lineUnit`): одиниця рядка й товар. */
export const PRINT_LINE_GOOD_SELECT = {
  unitOfMeasure: { select: { shortName: true } },
  good: { select: { name: true, unit: true, unitOfMeasure: { select: { shortName: true } } } },
} as const;

/** Перші колонки рядків товарів: назва, кількість, одиниця, ціна. */
export const GOODS_COLUMNS: readonly PrintableColumn[] = [
  { label: 'Найменування', kind: 'text' },
  { label: 'Кількість', kind: 'qty' },
  { label: 'Од.', kind: 'text' },
  { label: 'Ціна', kind: 'money' },
];

/** Сторона-контрагент: назва, ЄДРПОУ, телефон — те, що друкує рахунок (`partyBlock`). */
export function counterpartyParty(
  label: string,
  cp: {
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    phone: string | null;
    edrpou: string | null;
  } | null,
): PrintableParty {
  const name = formatPersonName(cp?.lastName, cp?.firstName, cp?.companyName);
  return {
    label,
    lines: [
      name || '—',
      ...(cp?.edrpou ? [`ЄДРПОУ: ${cp.edrpou}`] : []),
      ...(cp?.phone ? [`Тел.: ${cp.phone}`] : []),
    ],
  };
}

/** Одиниця рядка: одиниця рядка → базова одиниця товару → «шт» (BR-INV-021). */
export function lineUnit(
  line: {
    unitOfMeasure?: { shortName: string } | null;
    good?: { unit?: string | null; unitOfMeasure?: { shortName: string } | null } | null;
  },
  fallback = 'шт',
): string {
  return (
    line.unitOfMeasure?.shortName ??
    line.good?.unitOfMeasure?.shortName ??
    line.good?.unit ??
    fallback
  );
}
