import { BadRequestException } from '@nestjs/common';
import { Agg, ReportEntityDef, getField } from './report-registry';
import { REPORT_TAKE_CAP } from './report-query.builder';

export interface ReportAggInput {
  field: string;
  agg: Agg;
}

export interface AggregateValues {
  [alias: string]: number | null;
}

export interface GroupNode {
  /** Значення groupBy-поля цього рівня (нормалізований ключ; '∅' для null). */
  key: string;
  /** Підпис groupBy-поля (label з реєстру). */
  field: string;
  label: string;
  /** Сире значення для рендеру (як у першому рядку групи). */
  value: unknown;
  count: number;
  aggregates: AggregateValues;
  children: GroupNode[];
  /** Сирі рядки лише на листі й лише коли includeRows. */
  rows?: Record<string, unknown>[];
}

export interface ReportResult {
  tree: GroupNode[];
  grandTotals: AggregateValues;
  rowCount: number;
  truncated: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** Читає значення за dot-path з рядка (relation-поля лежать вкладено через include). */
function getPath(row: Row, prismaPath: string): unknown {
  const segments = prismaPath.split('.');
  let node: unknown = row;
  for (const seg of segments) {
    if (node == null || typeof node !== 'object') return undefined;
    node = (node as Row)[seg];
  }
  return node;
}

/** null/undefined → '∅' (єдина «порожня» група); решта → String. */
function normalizeKey(value: unknown): string {
  if (value === null || value === undefined || value === '') return '∅';
  return String(value);
}

/** Числове значення поля з урахуванням знакової quantity (signedByType). */
function numericValue(row: Row, entity: ReportEntityDef, field: string): number | null {
  const fld = getField(entity, field);
  const raw = getPath(row, fld.prismaPath);
  if (raw === null || raw === undefined) return null;
  let n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (fld.signedByType) {
    const typeVal = String(getPath(row, fld.signedByType) ?? '');
    // Витратні рухи від'ємні (WRITEOFF/RESERVATION), прихід додатний.
    if (typeVal === 'WRITEOFF' || typeVal === 'RESERVATION') n = -Math.abs(n);
  }
  return n;
}

/** Рахує вибрані агрегації над набором рядків. Whitelist + balance-SUM guard. */
function computeAggs(
  rows: Row[],
  aggs: ReportAggInput[],
  entity: ReportEntityDef,
): AggregateValues {
  const out: AggregateValues = {};
  for (const { field, agg } of aggs) {
    const fld = getField(entity, field);
    if (!fld.aggregations.includes(agg)) {
      throw new BadRequestException(`Агрегація ${agg} недозволена для "${fld.label}"`);
    }
    if (agg === 'SUM' && fld.stateNotFlow) {
      throw new BadRequestException(`SUM недозволена для "${fld.label}" (стан, не потік)`);
    }
    const alias = `${agg}_${field}`;
    if (agg === 'COUNT') {
      out[alias] = rows.length;
      continue;
    }
    const nums: number[] = [];
    for (const r of rows) {
      const v = numericValue(r, entity, field);
      if (v !== null) nums.push(v);
    }
    if (agg === 'SUM') {
      out[alias] = nums.reduce((s, x) => s + x, 0);
    } else if (nums.length === 0) {
      out[alias] = null; // AVG/MIN/MAX над порожнім = null (SQL-семантика)
    } else if (agg === 'AVG') {
      out[alias] = nums.reduce((s, x) => s + x, 0) / nums.length;
    } else if (agg === 'MIN') {
      out[alias] = Math.min(...nums);
    } else {
      out[alias] = Math.max(...nums);
    }
  }
  return out;
}

function buildLevel(
  rows: Row[],
  groupBy: string[],
  depth: number,
  aggs: ReportAggInput[],
  entity: ReportEntityDef,
  includeRows: boolean,
): GroupNode[] {
  if (depth >= groupBy.length) return [];
  const fld = getField(entity, groupBy[depth]);
  const buckets = new Map<string, Row[]>();
  const firstValue = new Map<string, unknown>();
  for (const r of rows) {
    const raw = getPath(r, fld.prismaPath);
    const k = normalizeKey(raw);
    let list = buckets.get(k);
    if (!list) {
      list = [];
      buckets.set(k, list);
      firstValue.set(k, raw ?? null);
    }
    list.push(r);
  }
  const isLeaf = depth === groupBy.length - 1;
  const nodes: GroupNode[] = [];
  for (const [k, groupRows] of buckets) {
    nodes.push({
      key: k,
      field: fld.key,
      label: fld.label,
      value: firstValue.get(k) ?? null,
      count: groupRows.length,
      aggregates: computeAggs(groupRows, aggs, entity),
      children: isLeaf ? [] : buildLevel(groupRows, groupBy, depth + 1, aggs, entity, includeRows),
      ...(isLeaf && includeRows ? { rows: groupRows } : {}),
    });
  }
  // Стабільний порядок: '∅' у кінець, решта за ключем.
  nodes.sort((a, b) => {
    if (a.key === '∅') return 1;
    if (b.key === '∅') return -1;
    return a.key.localeCompare(b.key, 'uk');
  });
  return nodes;
}

/**
 * Плоскі rows[] + config → ієрархічне дерево (≤5 рівнів) + grand totals.
 * grandTotals — НЕЗАЛЕЖНИЙ прохід по всій вибірці (для AVG це НЕ середнє груп — SQL-семантика).
 */
export function aggregate(
  rows: Row[],
  config: { groupBy: string[]; aggregations?: ReportAggInput[]; includeRows?: boolean },
  entity: ReportEntityDef,
): ReportResult {
  const aggs = config.aggregations ?? [];
  const grandTotals = computeAggs(rows, aggs, entity);
  const tree = buildLevel(rows, config.groupBy, 0, aggs, entity, config.includeRows ?? false);
  return {
    tree,
    grandTotals,
    rowCount: rows.length,
    truncated: rows.length >= REPORT_TAKE_CAP,
  };
}
