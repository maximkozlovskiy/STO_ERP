import type { ReportEntityDef, ReportFieldDef } from './report-registry';
import {
  documentCurrencyAggs,
  fieldValue,
  maskMixedCurrency,
  needsCurrency,
  normalizeKey,
  projectRows,
  sortNodes,
  isSummable,
  type AggregateValues,
  type CurrencyAggregates,
  type DetailRow,
  type GroupNode,
  type ReportAggInput,
} from './report-aggregator';
import { REPORT_GROUP_CAP, REPORT_MERGED_CAP } from './report-sql.builder';

/**
 * Рядки SQL-агрегатів (`report-sql.builder.ts`) → дерево груп, «Разом» і склеєні плоскі рядки у
 * тій самій формі, яку раніше давав JS-агрегатор над ≤5000 рядками. Чисті функції — без БД.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const KEY_SEP = '\u0001';

/** `a{j}` (текст із SQL) → число; NULL лишається null (AVG/MIN/MAX над порожнім). */
function aggValues(row: Row, aggs: ReportAggInput[]): AggregateValues {
  const out: AggregateValues = {};
  aggs.forEach((a, j) => {
    const raw = row[`a${j}`] as string | null | undefined;
    out[`${a.agg}_${a.field}`] = raw === null || raw === undefined ? null : Number(raw);
  });
  return out;
}

/** Значення групи для рендеру — як давав JS-агрегатор: день — `YYYY-MM-DD`, так/ні — boolean. */
function groupValue(fld: ReportFieldDef, key: string): unknown {
  if (key === '∅') return null;
  if (fld.type === 'boolean') return key === 'true';
  return key;
}

export interface AssembledTree {
  tree: GroupNode[];
  grandTotals: AggregateValues;
  grandTotalsByCurrency?: CurrencyAggregates;
  rowCount: number;
  groupsTruncated: boolean;
}

/**
 * Рядки `GROUP BY ROLLUP` → дерево. Рівень рядка — скільки ключів згруповано (`g{i}` = 0);
 * рядок без жодного ключа — «Разом». Детальні рядки (≤5000, Prisma) чіпляються до листових
 * груп за тими самими ключами (`normalizeKey`).
 */
export function assembleTree(
  rollup: Row[],
  groupFields: ReportFieldDef[],
  aggs: ReportAggInput[],
  opts: {
    detail: Row[] | null;
    columns: string[];
    entity: ReportEntityDef;
    sortByAggregate?: { alias: string; dir: 'asc' | 'desc' };
    /** Рядки `buildCurrencySplitSql` (null — у звіті немає агрегацій у валюті документа). */
    currencySplit?: Row[] | null;
    /** Базова валюта організації — замість порожньої валюти документа (BR-RPT-029). */
    baseCurrency: string;
  },
): AssembledTree {
  const { baseCurrency } = opts;
  const groupsTruncated = rollup.length > REPORT_GROUP_CAP;
  const rows = groupsTruncated ? rollup.slice(0, REPORT_GROUP_CAP) : rollup;
  const depth = groupFields.length;
  const level = (r: Row) => {
    let l = 0;
    while (l < depth && Number(r[`g${l}`]) === 0) l++;
    return l;
  };
  const keyOf = (r: Row, i: number) => {
    const k = r[`k${i}`] as string | null;
    return k === null || k === undefined ? '∅' : String(k);
  };
  const byCurrency = currencySplitByPath(
    opts.currencySplit ?? null,
    aggs,
    opts.entity,
    depth,
    level,
    keyOf,
  );

  let grandTotals: AggregateValues = {};
  let rowCount = 0;
  const nodes = new Map<string, GroupNode>();
  const roots: GroupNode[] = [];
  for (const r of [...rows].sort((a, b) => level(a) - level(b))) {
    const l = level(r);
    if (l === 0) {
      grandTotals = aggValues(r, aggs);
      rowCount = Number(r.n);
      if (byCurrency) maskMixedCurrency(grandTotals, byCurrency.get('') ?? {});
      continue;
    }
    const keys = Array.from({ length: l }, (_, i) => keyOf(r, i));
    const fld = groupFields[l - 1];
    const node: GroupNode = {
      key: keys[l - 1],
      field: fld.key,
      label: fld.label,
      value: groupValue(fld, keys[l - 1]),
      count: Number(r.n),
      aggregates: aggValues(r, aggs),
      children: [],
    };
    const split = byCurrency?.get(keys.join(KEY_SEP));
    if (byCurrency) {
      node.byCurrency = split ?? {};
      maskMixedCurrency(node.aggregates, node.byCurrency);
    }
    nodes.set(keys.join(KEY_SEP), node);
    if (l === 1) roots.push(node);
    else nodes.get(keys.slice(0, -1).join(KEY_SEP))?.children.push(node);
  }

  if (opts.detail) {
    const byLeaf = new Map<string, Row[]>();
    for (const d of opts.detail) {
      const path = groupFields
        .map(f =>
          normalizeKey(fieldValue(d, opts.entity, f.prismaPath, baseCurrency), f.type === 'date'),
        )
        .join(KEY_SEP);
      const list = byLeaf.get(path) ?? [];
      list.push(d);
      byLeaf.set(path, list);
    }
    for (const [path, node] of nodes) {
      if (path.split(KEY_SEP).length !== depth) continue;
      node.rows = projectRows(byLeaf.get(path) ?? [], opts.columns, opts.entity, baseCurrency);
    }
  }

  const sortAlias = opts.sortByAggregate?.alias ?? null;
  const sortDir = opts.sortByAggregate?.dir ?? 'desc';
  const sortDeep = (list: GroupNode[]) => {
    sortNodes(list, sortAlias, sortDir);
    list.forEach(n => sortDeep(n.children));
  };
  sortDeep(roots);
  return {
    tree: roots,
    grandTotals,
    ...(byCurrency ? { grandTotalsByCurrency: byCurrency.get('') ?? {} } : {}),
    rowCount,
    groupsTruncated,
  };
}

/**
 * Рядки `GROUPING SETS` розбивки за валютами → шлях групи (ключі через KEY_SEP; `''` — «Разом») →
 * alias → код валюти → значення. Агрегати рядка — у порядку `documentCurrencyAggs`.
 */
function currencySplitByPath(
  split: Row[] | null,
  aggs: ReportAggInput[],
  entity: ReportEntityDef,
  depth: number,
  level: (r: Row) => number,
  keyOf: (r: Row, i: number) => string,
): Map<string, CurrencyAggregates> | null {
  if (!split) return null;
  const docAggs = documentCurrencyAggs(aggs, entity);
  const out = new Map<string, CurrencyAggregates>();
  for (const r of split) {
    const l = depth === 0 ? 0 : level(r);
    const path = Array.from({ length: l }, (_, i) => keyOf(r, i)).join(KEY_SEP);
    let entry = out.get(path);
    if (!entry) {
      entry = Object.fromEntries(docAggs.map(a => [`${a.agg}_${a.field}`, {}]));
      out.set(path, entry);
    }
    const values = aggValues(r, docAggs);
    for (const [alias, v] of Object.entries(values)) entry[alias][String(r.cur)] = v;
  }
  return out;
}

/** Рядки склеювання (`buildMergedRowsSql`) → детальні рядки у формі `mergeDetailRows`. */
export function assembleMergedRows(
  merged: Row[],
  columns: string[],
  entity: ReportEntityDef,
): { detailRows: DetailRow[]; truncated: boolean } {
  const truncated = merged.length > REPORT_MERGED_CAP;
  const rows = truncated ? merged.slice(0, REPORT_MERGED_CAP) : merged;
  const dims = columns.filter(k => !isSummable(entity, k));
  const sums = columns.filter(k => isSummable(entity, k));
  const withCurrency = needsCurrency(entity, columns);
  const detailRows = rows.map(r => {
    const out: DetailRow = {};
    for (const key of columns) {
      const di = dims.indexOf(key);
      out[key] = di >= 0 ? (r[`d${di}`] ?? null) : Number(r[`s${sums.indexOf(key)}`]);
    }
    if (withCurrency) out.__currency = r.c0 ?? null;
    out.__mergedCount = Number(r.n);
    return out;
  });
  return { detailRows, truncated };
}
