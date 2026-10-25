// Експорт результату конструктора звітів у CSV / XLSX (BR-RPT-021) — винесено з
// `app/(app)/reports/ReportBuilder.tsx` без зміни поведінки, щоб чисту частину (рядки, CSV-текст,
// SpreadsheetML) можна було тестувати без React і без DOM. Єдина DOM-функція тут — `exportReport`.
// Тести: `lib/__tests__/report-export.test.ts`.

import type { TFunction } from 'i18next';
import type { Agg, GroupNode, ReportRunResult } from '@/hooks/api/useReportBuilder';
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

// ── Експорт CSV / XLSX (клієнтський, з дерева) ──────────────────────────────────
export function flattenTree(
  nodes: GroupNode[],
  aggAliases: string[],
  t: TFunction<'reports'>,
  depth = 0,
  result?: ReportRunResult,
  enumByField: Record<string, string> = {},
): string[][] {
  const rows: string[][] = [];
  for (const n of nodes) {
    const indent = '  '.repeat(depth);
    rows.push([
      indent + groupLabel(n, enumByField, t),
      String(n.count),
      ...aggAliases.map(a => exportAggValue(a, n.aggregates[a], result)),
    ]);
    if (n.children.length)
      rows.push(...flattenTree(n.children, aggAliases, t, depth + 1, result, enumByField));
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
  const aggAliases = Object.keys(result.result.grandTotals);
  let rows: string[][];

  if (result.groupBy.length) {
    // Групований режим — дерево груп (як на екрані), відступ = рівень ієрархії.
    const header = [
      t('export.group'),
      t('export.count'),
      ...aggAliases.map(a => aggAliasLabel(a, result, t)),
    ];
    const body = flattenTree(result.result.tree, aggAliases, t, 0, result, enumByField);
    const totals = [
      t('export.totals'),
      String(result.result.rowCount),
      ...aggAliases.map(a => exportAggValue(a, result.result.grandTotals[a], result)),
    ];
    rows = [header, ...body, totals];
  } else {
    // Плоский режим — СКЛЕЄНІ детальні рядки (ті самі, що на екрані), а не лише «Усього».
    const cols = result.columns;
    const detail = result.result.detailRows;
    const showCount = detail.some(r => typeof r.__mergedCount === 'number' && r.__mergedCount > 1);
    const header = [
      t('export.number'),
      ...cols.map(c => c.label),
      ...(showCount ? [t('export.merged')] : []),
      ...aggAliases.map(a => aggAliasLabel(a, result, t)),
    ];
    const body = detail.map((row, i) => [
      String(i + 1),
      ...cols.map(c => exportCell(row[c.key], c.type, c.enumName, t)),
      ...(showCount ? [String(typeof row.__mergedCount === 'number' ? row.__mergedCount : 1)] : []),
      ...aggAliases.map(() => ''),
    ]);
    const totals = [
      t('export.totals'),
      ...cols.map(() => ''),
      ...(showCount ? [String(result.result.rowCount)] : []),
      ...aggAliases.map(a => exportAggValue(a, result.result.grandTotals[a], result)),
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
  const aggs = Object.keys(result.result.grandTotals).map(a => aggFieldType(a, result) !== 'date');
  if (result.groupBy.length) return [false, true, ...aggs];
  const showCount = result.result.detailRows.some(
    r => typeof r.__mergedCount === 'number' && r.__mergedCount > 1,
  );
  return [
    false,
    ...result.columns.map(c => c.type === 'number' || c.type === 'decimal'),
    ...(showCount ? [true] : []),
    ...aggs,
  ];
}

const PLAIN_NUMBER_RE = /^-?\d+(\.\d+)?$/;

/** CSV-текст із рядків: роздільник — кома, кожна клітинка через escapeCsvCell. */
export function buildCsvText(rows: string[][]): string {
  // escapeCsvCell нейтралізує formula-injection (=,+,-,@) + квотує роздільник ',' . Чисте число
  // формулою бути не може, а апостроф перед «-4865.968» робив зі списання текст у Excel.
  return rows
    .map(r => r.map(c => (PLAIN_NUMBER_RE.test(c) ? c : escapeCsvCell(c, ','))).join(','))
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
      content: CSV_BOM + buildCsvText(rows),
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
