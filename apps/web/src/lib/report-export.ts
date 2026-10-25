// Експорт результату конструктора звітів у CSV / XLSX (BR-RPT-021) — винесено з
// `app/(app)/reports/ReportBuilder.tsx` без зміни поведінки, щоб чисту частину (рядки, CSV-текст,
// SpreadsheetML) можна було тестувати без React і без DOM. Єдина DOM-функція тут — `exportReport`.
// Тести: `lib/__tests__/report-export.test.ts`.

import type { TFunction } from 'i18next';
import type { Agg, GroupNode, ReportFilter, ReportRunResult } from '@/hooks/api/useReportBuilder';
import { fmtDate } from '@/lib/format';
import { escapeCsvCell } from '@/lib/utils';
import { downloadBlob } from '@/lib/download';
import {
  woStatusLabel,
  woPriorityLabel,
  invoiceStatusLabel,
  poStatusLabel,
  counterpartyTypeLabel,
  goodTypeLabel,
  stockMovementTypeLabel,
  settlementTxTypeLabel,
} from '@/i18n/enumLabel';

/** enumName реєстру → обгортка перекладу (мовою інтерфейсу). Bug: статуси показувались англійською. */
const ENUM_LABELS: Record<string, (code: string) => string> = {
  WorkOrderStatus: woStatusLabel,
  WorkOrderPriority: woPriorityLabel,
  InvoiceStatus: invoiceStatusLabel,
  PurchaseOrderStatus: poStatusLabel,
  CounterpartyType: counterpartyTypeLabel,
  GoodType: goodTypeLabel,
  StockMovementType: stockMovementTypeLabel,
  SettlementTransactionType: settlementTxTypeLabel,
};

/** Переклад enum-значення (fallback — сире значення, якщо мапи/ключа немає). */
export function enumLabel(enumName: string | undefined, value: unknown): string {
  const v = String(value ?? '');
  if (!enumName || !v) return v;
  const fn = ENUM_LABELS[enumName];
  return fn ? fn(v) : v;
}

export function aggAliasLabel(
  alias: string,
  result: ReportRunResult,
  t: TFunction<'reports'>,
): string {
  const us = alias.indexOf('_');
  const agg = alias.slice(0, us);
  const fieldKey = alias.slice(us + 1);
  // Bug #620: агрегатне поле може бути ВНЕ `columns` (напр. MIN documentDate без
  // documentDate у колонках) — беремо label з `aggregations` (backend enrichment),
  // fallback на `columns`, потім на fieldKey.
  const aggMeta = result.aggregations.find(a => a.field === fieldKey);
  const col = result.columns.find(c => c.key === fieldKey);
  const label = aggMeta?.label ?? col?.label ?? fieldKey;
  // Короткий префікс (Σ Сума, сер. Ціна) — уникає «Сума: Сума» для авто-SUM грошових колонок.
  const short = (['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'] as Agg[]).includes(agg as Agg)
    ? t(`aggShort.${agg as Agg}`)
    : agg;
  return `${short} ${label}`;
}

/**
 * Значення фільтра дати для вибору дати (`РРРР-ММ-ДД`). Бекенд приймає і `ДД.ММ.РРРР`
 * (BR-RPT-025), а вибір дати показує лише ISO — збережений звіт із «22.10.2026» фільтрував
 * звіт, а поле дати лишалось порожнім (Bug #974). Інше значення — порожнє: його бекенд відхилить.
 */
export function filterDayValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  const ua = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (ua) return `${ua[3]}-${ua[2]}-${ua[1]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/**
 * «Заповнене» — оператор лише інтерфейсу: на бекенд іде `isNull` зі значенням `false` (BR-RPT-024).
 * Без нього не можна було показати саме сторновані платежі, які звіт за замовчуванням відсікає
 * (BR-RPT-026).
 */
export const NOT_NULL = 'notNull';
export type FilterOpChoice = ReportFilter['op'] | typeof NOT_NULL;

export function filterOpChoice(f: ReportFilter): FilterOpChoice {
  return f.op === 'isNull' && (f.value === false || f.value === 'false') ? NOT_NULL : f.op;
}

/** Зміна оператора: «порожнє» / «заповнене» несуть свій value, вихід із них скидає значення. */
export function filterOpPatch(f: ReportFilter, choice: FilterOpChoice): Partial<ReportFilter> {
  if (choice === NOT_NULL) return { op: 'isNull', value: false };
  if (choice === 'isNull' || f.op === 'isNull') return { op: choice, value: undefined };
  return { op: choice };
}

/** Підпис групи — той самий на екрані й у файлі: enum перекладений, так/ні, день — ДД.ММ.РРРР. */
export function groupLabel(
  node: GroupNode,
  enumByField: Record<string, string>,
  t: TFunction<'reports'>,
): string {
  if (node.key === '∅') return t('result.emptyGroup');
  const v = node.value;
  if (typeof v === 'boolean') return v ? t('result.boolYes') : t('result.boolNo');
  const enumName = enumByField[node.field];
  if (enumName) return enumLabel(enumName, v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return fmtDate(v);
  return String(v ?? node.key);
}

/** Тип поля агрегату за alias `AGG_поле`: з ефективних агрегацій, далі з колонок. */
function aggFieldType(alias: string, result: ReportRunResult | undefined): string | undefined {
  // COUNT — завжди ціле число, навіть над полем-датою (як `fmtAggValue` на екрані).
  if (alias.startsWith('COUNT_')) return 'number';
  if (!result) return undefined;
  const fieldKey = alias.slice(alias.indexOf('_') + 1);
  return (
    result.aggregations.find(a => a.field === fieldKey)?.type ??
    result.columns.find(c => c.key === fieldKey)?.type
  );
}

/** Число для файла без хвоста двійкового дробу: 0.1 + 0.2 — «0.3», а не «0.30000000000000004». */
function exportNumber(n: number): string {
  return String(Number(n.toFixed(6)));
}

/** Значення агрегату для файла: MIN/MAX дати — ДД.ММ.РРРР (бекенд шле мітку часу в мс), решта — число. */
export function exportAggValue(
  alias: string,
  value: number | null | undefined,
  result?: ReportRunResult,
): string {
  if (value === null || value === undefined) return '';
  if (aggFieldType(alias, result) === 'date') return fmtDate(new Date(value));
  return exportNumber(value);
}

// ── Суми у валюті документа (BR-RPT-029) ─────────────────────────────────────────

type ByCurrency = Record<string, Record<string, number | null>> | undefined;

/** Агрегація у валюті документа: її значення має сенс лише разом із кодом валюти. */
export function isDocumentCurrencyAlias(alias: string, result: ReportRunResult): boolean {
  const fieldKey = alias.slice(alias.indexOf('_') + 1);
  const agg = alias.slice(0, alias.indexOf('_'));
  return result.aggregations.some(
    a => a.field === fieldKey && a.agg === agg && a.inDocumentCurrency === true,
  );
}

/** Валюти вибірки для агрегації: базова першою, далі за абеткою (з розбивки «Разом»). */
export function selectionCurrencies(alias: string, result: ReportRunResult): string[] {
  const codes = Object.keys(result.result.grandTotalsByCurrency?.[alias] ?? {});
  const base = result.baseCurrency;
  return codes.sort((a, b) => (a === base ? -1 : b === base ? 1 : a.localeCompare(b)));
}

/**
 * Рядки клітинки суми у валюті документа: «сума КОД» на кожну валюту групи (одна валюта — один
 * рядок). null — агрегація не у валюті документа або розбивки немає (рендер звичайним числом).
 */
export function currencyLines(
  alias: string,
  byCurrency: ByCurrency,
  result: ReportRunResult,
): { code: string; value: number | null }[] | null {
  if (!isDocumentCurrencyAlias(alias, result) || !byCurrency?.[alias]) return null;
  const perCode = byCurrency[alias];
  return selectionCurrencies(alias, result)
    .filter(code => code in perCode)
    .map(code => ({ code, value: perCode[code] ?? null }));
}

/** Колонка агрегації у файлі: сума у валюті документа — окрема колонка на кожну валюту вибірки. */
export interface AggExportColumn {
  alias: string;
  code?: string;
}

function aggExportColumns(result: ReportRunResult): AggExportColumn[] {
  return Object.keys(result.result.grandTotals).flatMap(alias => {
    if (!isDocumentCurrencyAlias(alias, result) || !result.result.grandTotalsByCurrency) {
      return [{ alias }];
    }
    return selectionCurrencies(alias, result).map(code => ({ alias, code }));
  });
}

function aggExportHeader(col: AggExportColumn, result: ReportRunResult, t: TFunction<'reports'>) {
  const label = aggAliasLabel(col.alias, result, t);
  return col.code ? `${label}, ${col.code}` : label;
}

function aggExportValue(
  col: AggExportColumn,
  values: Record<string, number | null>,
  byCurrency: ByCurrency,
  result: ReportRunResult,
): string {
  if (!col.code) return exportAggValue(col.alias, values[col.alias], result);
  return exportAggValue(col.alias, byCurrency?.[col.alias]?.[col.code], result);
}

/** Чи потрібна детальним рядкам колонка «Валюта» (є колонка у валюті документа). */
function hasCurrencyColumn(result: ReportRunResult): boolean {
  return result.columns.some(c => c.inDocumentCurrency === true);
}

// ── Експорт CSV / XLSX (клієнтський, з дерева) ──────────────────────────────────
export function flattenTree(
  nodes: GroupNode[],
  aggColumns: AggExportColumn[],
  t: TFunction<'reports'>,
  result: ReportRunResult,
  depth = 0,
  enumByField: Record<string, string> = {},
): string[][] {
  const rows: string[][] = [];
  for (const n of nodes) {
    const indent = '  '.repeat(depth);
    rows.push([
      indent + groupLabel(n, enumByField, t),
      String(n.count),
      ...aggColumns.map(c => aggExportValue(c, n.aggregates, n.byCurrency, result)),
    ]);
    if (n.children.length)
      rows.push(...flattenTree(n.children, aggColumns, t, result, depth + 1, enumByField));
  }
  return rows;
}

/**
 * Клітинка експорту для значення колонки: enum → переклад, boolean → Так/Ні,
 * дата → ДД.ММ.РРРР, число як є (raw, щоб XLSX детектив ss:Type="Number").
 * Мусить давати ТІ САМІ лейбли, що й fmtCell на екрані (окрім числового форматування,
 * яке в експорті лишається сирим навмисно) — інакше розбіжність екран↔файл.
 */
export function exportCell(
  value: unknown,
  type: string,
  enumName: string | undefined,
  t: TFunction<'reports'>,
): string {
  if (type === 'boolean' && typeof value === 'boolean')
    return value ? t('result.boolYes') : t('result.boolNo');
  if (value === null || value === undefined) return '';
  if (enumName) return enumLabel(enumName, value);
  if (type === 'date') return fmtDate(String(value));
  if (typeof value === 'number') return exportNumber(value);
  return String(value);
}

/** BOM на початку CSV — щоб Excel відкрив UTF-8 (кирилицю) без кракозябр. */
export const CSV_BOM = '\uFEFF';

/** Чиста частина експорту: результат звіту → рядки таблиці (заголовок, тіло, «Усього»). */
export function buildExportRows(
  result: ReportRunResult,
  t: TFunction<'reports'>,
  enumByField: Record<string, string> = {},
): string[][] {
  const aggColumns = aggExportColumns(result);
  const { grandTotals, grandTotalsByCurrency } = result.result;
  const totalsCells = aggColumns.map(c =>
    aggExportValue(c, grandTotals, grandTotalsByCurrency, result),
  );
  let rows: string[][];

  if (result.groupBy.length) {
    // Групований режим — дерево груп (як на екрані), відступ = рівень ієрархії.
    const header = [
      t('export.group'),
      t('export.count'),
      ...aggColumns.map(c => aggExportHeader(c, result, t)),
    ];
    const body = flattenTree(result.result.tree, aggColumns, t, result, 0, enumByField);
    const totals = [t('export.totals'), String(result.result.rowCount), ...totalsCells];
    rows = [header, ...body, totals];
  } else {
    // Плоский режим — СКЛЕЄНІ детальні рядки (ті самі, що на екрані), а не лише «Усього».
    const cols = result.columns;
    const detail = result.result.detailRows;
    const showCount = detail.some(r => typeof r.__mergedCount === 'number' && r.__mergedCount > 1);
    const withCurrency = hasCurrencyColumn(result);
    const header = [
      t('export.number'),
      ...cols.map(c => c.label),
      ...(withCurrency ? [t('export.currency')] : []),
      ...(showCount ? [t('export.merged')] : []),
      ...aggColumns.map(c => aggExportHeader(c, result, t)),
    ];
    const body = detail.map((row, i) => [
      String(i + 1),
      ...cols.map(c => exportCell(row[c.key], c.type, c.enumName, t)),
      ...(withCurrency ? [String(row.__currency ?? '')] : []),
      ...(showCount ? [String(typeof row.__mergedCount === 'number' ? row.__mergedCount : 1)] : []),
      ...aggColumns.map(() => ''),
    ]);
    const totals = [
      t('export.totals'),
      ...cols.map(() => ''),
      ...(withCurrency ? [''] : []),
      ...(showCount ? [String(result.result.rowCount)] : []),
      ...totalsCells,
    ];
    rows = [header, ...body, totals];
  }

  return rows;
}

/**
 * Які колонки файла числові — за ТИПОМ колонки звіту, а не за вмістом клітинки: артикул
 * «0451103316» чи номер «00123» — текст, і Excel не має зрізати їм нулі. Порядок колонок — як у
 * `buildExportRows`.
 */
export function buildExportNumericColumns(result: ReportRunResult): boolean[] {
  const aggs = aggExportColumns(result).map(c => aggFieldType(c.alias, result) !== 'date');
  if (result.groupBy.length) return [false, true, ...aggs];
  const showCount = result.result.detailRows.some(
    r => typeof r.__mergedCount === 'number' && r.__mergedCount > 1,
  );
  return [
    false,
    ...result.columns.map(c => c.type === 'number' || c.type === 'decimal'),
    ...(hasCurrencyColumn(result) ? [false] : []),
    ...(showCount ? [true] : []),
    ...aggs,
  ];
}

const PLAIN_NUMBER_RE = /^-?\d+(\.\d+)?$/;

/**
 * CSV-текст із рядків: роздільник — `;`, як в інших CSV застосунку (звіти, взаєморозрахунки):
 * Excel з українськими регіональними налаштуваннями розбиває колонки саме за ним, а файл через кому
 * відкривав одним стовпцем. Кожна клітинка — через escapeCsvCell (захист від формул + лапки).
 * Число в числовій колонці (`numericColumns`, як у XLSX) — з десятковою комою, як його читає
 * Excel з українськими налаштуваннями; текстова колонка лишається як є (артикул «1.05»).
 */
export function buildCsvText(rows: string[][], numericColumns?: boolean[]): string {
  return rows
    .map(r =>
      r
        .map((c, i) =>
          escapeCsvCell(
            numericColumns?.[i] === true && PLAIN_NUMBER_RE.test(c) ? c.replace('.', ',') : c,
          ),
        )
        .join(';'),
    )
    .join('\n');
}

/** Готовий до завантаження файл експорту (ще без DOM): вміст, MIME і назва. */
export interface ReportExportFile {
  content: string;
  mime: string;
  filename: string;
}

export function buildExportFile(
  result: ReportRunResult,
  format: 'csv' | 'xlsx',
  t: TFunction<'reports'>,
  enumByField: Record<string, string> = {},
): ReportExportFile {
  const rows = buildExportRows(result, t, enumByField);
  if (format === 'csv') {
    return {
      content: CSV_BOM + buildCsvText(rows, buildExportNumericColumns(result)),
      mime: 'text/csv;charset=utf-8;',
      filename: `report-${result.entity}.csv`,
    };
  }
  // XLSX через SpreadsheetML (простий, без бібліотеки) — відкривається Excel-ом.
  return {
    content: buildXlsxXml(rows, t, buildExportNumericColumns(result)),
    mime: 'application/vnd.ms-excel',
    filename: `report-${result.entity}.xls`,
  };
}

/** DOM-частина: зібраний файл → Blob → завантаження у браузері. */
export function exportReport(
  result: ReportRunResult,
  format: 'csv' | 'xlsx',
  t: TFunction<'reports'>,
  enumByField: Record<string, string> = {},
): void {
  const file = buildExportFile(result, format, t, enumByField);
  downloadBlob(new Blob([file.content], { type: file.mime }), file.filename);
}

/** `numericColumns` — числові колонки за типом (`buildExportNumericColumns`); без нього — за вмістом. */
export function buildXlsxXml(
  rows: string[][],
  t: TFunction<'reports'>,
  numericColumns?: boolean[],
): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cells = (r: string[], isHeader: boolean) =>
    r
      .map((c, i) => {
        const numericColumn = numericColumns ? numericColumns[i] === true : i > 0;
        const num = numericColumn && PLAIN_NUMBER_RE.test(c);
        return num
          ? `<Cell><Data ss:Type="Number">${c}</Data></Cell>`
          : `<Cell><Data ss:Type="String">${esc(c)}</Data></Cell>`;
      })
      .join('');
  const body = rows.map((r, i) => `<Row>${cells(r, i === 0)}</Row>`).join('');
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="${t('export.sheetName')}"><Table>${body}</Table></Worksheet></Workbook>`;
}
