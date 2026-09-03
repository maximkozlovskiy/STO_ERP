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

/** Проєкція одного детального рядка: значення обраних колонок за їх key. */
export type DetailRow = Record<string, unknown>;

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
  /** Детальні рядки (проєкція columns) на листовому вузлі, коли includeRows. */
  rows?: DetailRow[];
}

export interface ReportResult {
  /** Дерево груп (порожнє коли groupBy=[]). */
  tree: GroupNode[];
  /** Плоскі детальні рядки (проєкція columns) — заповнюються коли includeRows і groupBy=[]. */
  detailRows: DetailRow[];
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

/**
 * null/undefined → '∅' (єдина «порожня» група); date → YYYY-MM-DD (групування по ДНЮ,
 * без годин — інакше кожна секунда окрема група); решта → String.
 *
 * TZ-critical: DateTime поля (createdAt тощо) містять час → «день» рахуємо у KYIV
 * (не UTC), інакше рух о 01:30 04.09 Kyiv (=22:30 03.09 UTC) потрапляв би у
 * бакет '2026-09-03'. `@db.Date` (без часу) Prisma повертає як 00:00 UTC — тут
 * Kyiv-конверсія дає той самий Y-M-D. Формат 'sv-SE' → 'YYYY-MM-DD'.
 */
const KYIV_YMD = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });

function normalizeKey(value: unknown, isDate: boolean): string {
  if (value === null || value === undefined || value === '') return '∅';
  if (isDate) {
    const d = value instanceof Date ? value : new Date(String(value));
    if (!isNaN(d.getTime())) return KYIV_YMD.format(d); // YYYY-MM-DD @ Europe/Kyiv
  }
  return String(value);
}

/** Числове значення поля з урахуванням знакової quantity (signedByType).
 *
 * Bug #619: для stockMovement.quantity (signedByType='type') історична логіка форсувала
 * знак за типом. Але RESERVATION/RESERVATION_RELEASE — НЕ фізичні рухи (див.
 * inventory.service.ts:187-190: quantityDelta = 0 для обох; вони чіпають лише лічильник
 * `reserved`). Тому у нетто-агрегації SUM(quantity) вони мають бути виключені —
 * інакше «Кількість (нетто)» показує привид від резервувань.
 *
 * WRITEOFF залишається `-Math.abs(n)` як backstop (якщо якийсь клієнт зберіг WRITEOFF з
 * додатною quantity — усе одно повернеться від'ємне значення). RECEIPT/TRANSFER/
 * OPENING_BALANCE — беруться as-is: їхній знак приходить правильним з сервісу
 * (RECEIPT >0, TRANSFER-writeoff <0, TRANSFER-receipt >0).
 */
const NON_PHYSICAL_MOVEMENT_TYPES = new Set(['RESERVATION', 'RESERVATION_RELEASE']);

function numericValue(row: Row, entity: ReportEntityDef, field: string): number | null {
  const fld = getField(entity, field);
  const raw = getPath(row, fld.prismaPath);
  if (raw === null || raw === undefined) return null;
  let n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (fld.signedByType) {
    const typeVal = String(getPath(row, fld.signedByType) ?? '');
    // Non-physical movements не беруть участі у фізичному нетто (Bug #619).
    if (NON_PHYSICAL_MOVEMENT_TYPES.has(typeVal)) return null;
    if (typeVal === 'WRITEOFF') n = -Math.abs(n);
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

/** Впорядковує вузли одного рівня: за агрегатом (якщо задано sortAlias) або за ключем. */
function sortNodes(nodes: GroupNode[], sortAlias: string | null, sortDir: 'asc' | 'desc'): void {
  if (sortAlias) {
    // За агрегатом '∅'-група бере участь як звичайна (її сума може бути найбільшою — не
    // форсуємо в кінець, інакше «топ за сумою» не відсортується коректно).
    // hasOwnProperty guard проти prototype-poisoning: aggregates['__proto__'] інакше
    // повертає Object.prototype → arith NaN, undefined sort order.
    nodes.sort((a, b) => {
      const av = Object.prototype.hasOwnProperty.call(a.aggregates, sortAlias)
        ? (a.aggregates[sortAlias] ?? 0)
        : 0;
      const bv = Object.prototype.hasOwnProperty.call(b.aggregates, sortAlias)
        ? (b.aggregates[sortAlias] ?? 0)
        : 0;
      return sortDir === 'asc' ? av - bv : bv - av;
    });
  } else {
    // Алфавітний порядок за ключем: '∅' (порожні) у кінець.
    nodes.sort((a, b) => {
      if (a.key === '∅') return 1;
      if (b.key === '∅') return -1;
      return a.key.localeCompare(b.key, 'uk');
    });
  }
}

function buildLevel(
  rows: Row[],
  groupBy: string[],
  depth: number,
  aggs: ReportAggInput[],
  entity: ReportEntityDef,
  includeRows: boolean,
  columns: string[],
  sortAlias: string | null,
  sortDir: 'asc' | 'desc',
): GroupNode[] {
  if (depth >= groupBy.length) return [];
  const fld = getField(entity, groupBy[depth]);
  const isDate = fld.type === 'date';
  const buckets = new Map<string, Row[]>();
  const firstValue = new Map<string, unknown>();
  for (const r of rows) {
    const raw = getPath(r, fld.prismaPath);
    const k = normalizeKey(raw, isDate);
    let list = buckets.get(k);
    if (!list) {
      list = [];
      buckets.set(k, list);
      // Для дат value = нормалізований день (YYYY-MM-DD), щоб рендер показував день, не timestamp.
      firstValue.set(k, isDate && k !== '∅' ? k : (raw ?? null));
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
      children: isLeaf
        ? []
        : buildLevel(
            groupRows,
            groupBy,
            depth + 1,
            aggs,
            entity,
            includeRows,
            columns,
            sortAlias,
            sortDir,
          ),
      ...(isLeaf && includeRows && columns.length > 0
        ? { rows: projectRows(groupRows, columns, entity) }
        : {}),
    });
  }
  sortNodes(nodes, sortAlias, sortDir);
  return nodes;
}

/** Проєкція сирих рядків у детальні (лише обрані columns, за їх key). */
function projectRows(rows: Row[], columns: string[], entity: ReportEntityDef): DetailRow[] {
  return rows.map(r => {
    const out: DetailRow = {};
    for (const key of columns) {
      const fld = getField(entity, key);
      out[key] = getPath(r, fld.prismaPath) ?? null;
    }
    return out;
  });
}

/**
 * Плоскі rows[] + config → ієрархічне дерево (≤5 рівнів) + детальні рядки + grand totals.
 * grandTotals — НЕЗАЛЕЖНИЙ прохід по всій вибірці (для AVG це НЕ середнє груп — SQL-семантика).
 * `sortByAggregate` (alias, напр. 'SUM_amount') сортує ГРУПИ на кожному рівні за цим агрегатом.
 */
export function aggregate(
  rows: Row[],
  config: {
    groupBy: string[];
    columns?: string[];
    aggregations?: ReportAggInput[];
    includeRows?: boolean;
    sortByAggregate?: { alias: string; dir: 'asc' | 'desc' };
  },
  entity: ReportEntityDef,
): ReportResult {
  const aggs = config.aggregations ?? [];
  const columns = config.columns ?? [];
  const includeRows = config.includeRows ?? false;
  const sortAlias = config.sortByAggregate?.alias ?? null;
  const sortDir = config.sortByAggregate?.dir ?? 'desc';

  const grandTotals = computeAggs(rows, aggs, entity);
  const tree = buildLevel(
    rows,
    config.groupBy,
    0,
    aggs,
    entity,
    includeRows,
    columns,
    sortAlias,
    sortDir,
  );
  // Без групування — детальні рядки на верхньому рівні (плоска таблиця записів).
  // Пропускаємо коли columns=[] — інакше отримали б N порожніх об'єктів (шум у мережі).
  const detailRows =
    config.groupBy.length === 0 && includeRows && columns.length > 0
      ? projectRows(rows, columns, entity)
      : [];

  return {
    tree,
    detailRows,
    grandTotals,
    rowCount: rows.length,
    truncated: rows.length >= REPORT_TAKE_CAP,
  };
}
