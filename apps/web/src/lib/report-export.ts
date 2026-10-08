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

// ── Експорт CSV / XLSX (клієнтський, з дерева) ──────────────────────────────────
export function flattenTree(
  nodes: GroupNode[],
  aggAliases: string[],
  t: TFunction<'reports'>,
  depth = 0,
): string[][] {
  const rows: string[][] = [];
  for (const n of nodes) {
    const indent = '  '.repeat(depth);
    const label = n.key === '∅' ? t('result.emptyGroup') : String(n.value ?? n.key);
    rows.push([
      indent + label,
      String(n.count),
      ...aggAliases.map(a => {
        const v = n.aggregates[a];
        return v === null || v === undefined ? '' : String(v);
      }),
    ]);
    if (n.children.length) rows.push(...flattenTree(n.children, aggAliases, t, depth + 1));
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
  return String(value);
}

/** BOM на початку CSV — щоб Excel відкрив UTF-8 (кирилицю) без кракозябр. */
export const CSV_BOM = '\uFEFF';

/** Чиста частина експорту: результат звіту → рядки таблиці (заголовок, тіло, «Усього»). */
export function buildExportRows(result: ReportRunResult, t: TFunction<'reports'>): string[][] {
  const aggAliases = Object.keys(result.result.grandTotals);
  let rows: string[][];

  if (result.groupBy.length) {
    // Групований режим — дерево груп (як на екрані), відступ = рівень ієрархії.
    const header = [
      t('export.group'),
      t('export.count'),
      ...aggAliases.map(a => aggAliasLabel(a, result, t)),
    ];
    const body = flattenTree(result.result.tree, aggAliases, t);
    const totals = [
      t('export.totals'),
      String(result.result.rowCount),
      ...aggAliases.map(a => String(result.result.grandTotals[a] ?? '')),
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
      ...aggAliases.map(a => String(result.result.grandTotals[a] ?? '')),
    ];
    rows = [header, ...body, totals];
  }

  return rows;
}

/** CSV-текст із рядків: роздільник — кома, кожна клітинка через escapeCsvCell. */
export function buildCsvText(rows: string[][]): string {
  // escapeCsvCell нейтралізує formula-injection (=,+,-,@) + квотує роздільник ',' .
  return rows.map(r => r.map(c => escapeCsvCell(c, ',')).join(',')).join('\n');
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
): ReportExportFile {
  const rows = buildExportRows(result, t);
  if (format === 'csv') {
    return {
      content: CSV_BOM + buildCsvText(rows),
      mime: 'text/csv;charset=utf-8;',
      filename: `report-${result.entity}.csv`,
    };
  }
  // XLSX через SpreadsheetML (простий, без бібліотеки) — відкривається Excel-ом.
  return {
    content: buildXlsxXml(rows, t),
    mime: 'application/vnd.ms-excel',
    filename: `report-${result.entity}.xls`,
  };
}

/** DOM-частина: зібраний файл → Blob → завантаження у браузері. */
export function exportReport(
  result: ReportRunResult,
  format: 'csv' | 'xlsx',
  t: TFunction<'reports'>,
): void {
  const file = buildExportFile(result, format, t);
  downloadBlob(new Blob([file.content], { type: file.mime }), file.filename);
}

export function buildXlsxXml(rows: string[][], t: TFunction<'reports'>): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cells = (r: string[], isHeader: boolean) =>
    r
      .map((c, i) => {
        const num = i > 0 && c !== '' && !isNaN(Number(c));
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
