import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import type { Agg, ReportEntityDef } from './report-registry';
import { getField, needsCurrency } from './report-registry';

export { needsCurrency } from './report-registry';
import { REPORT_TAKE_CAP } from './report-query.builder';

export interface ReportAggInput {
  field: string;
  agg: Agg;
}

export interface AggregateValues {
  [alias: string]: number | null;
}

/** Агрегації у валюті документа за кодом валюти: alias → { UAH: 254216.55, USD: 344 } (BR-RPT-029). */
export type CurrencyAggregates = Record<string, Record<string, number | null>>;

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
  /** Розбивка агрегацій у валюті документа за валютою (є, коли такі агрегації в звіті). */
  byCurrency?: CurrencyAggregates;
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
  /** Розбивка «Разом» для агрегацій у валюті документа (є, коли такі агрегації в звіті). */
  grandTotalsByCurrency?: CurrencyAggregates;
  /** Скільки рядків відповідає умовам — точне (SQL), не обрізане лімітом детальних. */
  rowCount: number;
  /** Детальних рядків показано не всі (ліміт 5000) — групи й підсумки від цього не залежать. */
  detailTruncated: boolean;
  /** Груп більше за ліміт відповіді — показано не всі. */
  groupsTruncated: boolean;
  /** Застаріле: `detailTruncated || groupsTruncated` (для клієнтів до 2026-10-25). */
  truncated: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** Читає значення за dot-path з рядка (relation-поля лежать вкладено через include). */
export function getPath(row: Row, prismaPath: string): unknown {
  const segments = prismaPath.split('.');
  let node: unknown = row;
  for (const seg of segments) {
    if (node == null || typeof node !== 'object') return undefined;
    node = (node as Row)[seg];
  }
  return node;
}

/**
 * Значення поля рядка з підстановкою базової валюти: код валюти документа, якого немає
 * (`currencyId = NULL` у старих платежах і проводках), — це базова валюта (BR-RPT-029).
 */
export function fieldValue(
  row: Row,
  entity: ReportEntityDef,
  prismaPath: string,
  baseCurrency: string,
): unknown {
  const v = getPath(row, prismaPath);
  return prismaPath === entity.currencyPath && (v === null || v === undefined) ? baseCurrency : v;
}

/** Агрегації у валюті документа з переліку. */
export function documentCurrencyAggs(
  aggs: ReportAggInput[],
  entity: ReportEntityDef,
): ReportAggInput[] {
  if (!entity.currencyPath) return [];
  return aggs.filter(
    a => a.agg !== 'COUNT' && getField(entity, a.field).inDocumentCurrency === true,
  );
}

/**
 * Значення агрегації у валюті документа має сенс лише в межах однієї валюти: якщо в групі їх кілька,
 * спільне значення — null, а цифри — у розбивці `byCurrency` (рішення власника 2026-10-25).
 */
export function maskMixedCurrency(values: AggregateValues, byCurrency: CurrencyAggregates): void {
  for (const [alias, perCurrency] of Object.entries(byCurrency)) {
    if (Object.keys(perCurrency).length > 1) values[alias] = null;
  }
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

export function normalizeKey(value: unknown, isDate: boolean): string {
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
export const NON_PHYSICAL_MOVEMENT_TYPES: ReadonlySet<string> = new Set([
  'RESERVATION',
  'RESERVATION_RELEASE',
]);

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

/** Агрегація поля — лише з білого списку реєстру (BR-RPT-011); SUM стану заборонений. */
export function assertAggregations(aggs: ReportAggInput[], entity: ReportEntityDef): void {
  for (const { field, agg } of aggs) {
    const fld = getField(entity, field);
    if (!fld.aggregations.includes(agg)) {
      throw new BadRequestException(
        translateError('err.reportBuilder.aggregationNotAllowed', getLocale(), {
          agg,
          label: fld.label,
        }),
      );
    }
    if (agg === 'SUM' && fld.stateNotFlow) {
      throw new BadRequestException(
        translateError('err.reportBuilder.sumNotAllowedState', getLocale(), { label: fld.label }),
      );
    }
  }
}

/** Розбивка агрегацій у валюті документа за кодом валюти (JS-еталон до SQL GROUPING SETS). */
function computeByCurrency(
  rows: Row[],
  aggs: ReportAggInput[],
  entity: ReportEntityDef,
  baseCurrency: string,
): CurrencyAggregates {
  const docAggs = documentCurrencyAggs(aggs, entity);
  const out: CurrencyAggregates = {};
  if (docAggs.length === 0 || !entity.currencyPath) return out;
  const path = entity.currencyPath;
  const byCode = new Map<string, Row[]>();
  for (const r of rows) {
    const code = String(fieldValue(r, entity, path, baseCurrency));
    byCode.set(code, [...(byCode.get(code) ?? []), r]);
  }
  for (const a of docAggs) out[`${a.agg}_${a.field}`] = {};
  for (const [code, group] of byCode) {
    const values = computeAggs(group, docAggs, entity);
    for (const [alias, v] of Object.entries(values)) out[alias][code] = v;
  }
  return out;
}

/** Рахує вибрані агрегації над набором рядків. Whitelist + balance-SUM guard. */
function computeAggs(
  rows: Row[],
  aggs: ReportAggInput[],
  entity: ReportEntityDef,
): AggregateValues {
  assertAggregations(aggs, entity);
  const out: AggregateValues = {};
  for (const { field, agg } of aggs) {
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
export function sortNodes(
  nodes: GroupNode[],
  sortAlias: string | null,
  sortDir: 'asc' | 'desc',
  baseCurrency: string,
): void {
  if (sortAlias) {
    // За агрегатом '∅'-група бере участь як звичайна (її сума може бути найбільшою — не
    // форсуємо в кінець, інакше «топ за сумою» не відсортується коректно).
    // hasOwnProperty guard проти prototype-poisoning: aggregates['__proto__'] інакше
    // повертає Object.prototype → arith NaN, undefined sort order.
    // Сума у валюті документа (BR-RPT-029) порівнянна лише в одній валюті. Порядок: групи в базовій
    // валюті (за сумою), далі групи в одній «чужій» валюті (за кодом, у ній — за сумою), у кінці —
    // групи з кількома валютами (спільного числа немає) — за будь-якого напрямку, як NULLS LAST.
    // Інакше «233 USD» ставала серед гривневих груп як 233 грн (рішення власника 2026-10-26).
    const currencies = (n: GroupNode) => Object.keys(n.byCurrency?.[sortAlias] ?? {});
    const rank = (n: GroupNode) => {
      const codes = currencies(n);
      if (codes.length > 1) return 2;
      return codes.length === 1 && codes[0] !== baseCurrency ? 1 : 0;
    };
    nodes.sort((a, b) => {
      const ar = rank(a);
      const br = rank(b);
      if (ar !== br) return ar - br;
      if (ar === 1) {
        const byCode = currencies(a)[0].localeCompare(currencies(b)[0]);
        if (byCode !== 0) return byCode;
      }
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
  baseCurrency: string,
): GroupNode[] {
  if (depth >= groupBy.length) return [];
  const fld = getField(entity, groupBy[depth]);
  const isDate = fld.type === 'date';
  const buckets = new Map<string, Row[]>();
  const firstValue = new Map<string, unknown>();
  for (const r of rows) {
    const raw = fieldValue(r, entity, fld.prismaPath, baseCurrency);
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
  const splitByCurrency = documentCurrencyAggs(aggs, entity).length > 0;
  for (const [k, groupRows] of buckets) {
    const aggregates = computeAggs(groupRows, aggs, entity);
    const byCurrency = splitByCurrency
      ? computeByCurrency(groupRows, aggs, entity, baseCurrency)
      : undefined;
    if (byCurrency) maskMixedCurrency(aggregates, byCurrency);
    nodes.push({
      key: k,
      field: fld.key,
      label: fld.label,
      value: firstValue.get(k) ?? null,
      count: groupRows.length,
      aggregates,
      ...(byCurrency ? { byCurrency } : {}),
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
            baseCurrency,
          ),
      ...(isLeaf && includeRows && columns.length > 0
        ? { rows: projectRows(groupRows, columns, entity, baseCurrency) }
        : {}),
    });
  }
  sortNodes(nodes, sortAlias, sortDir, baseCurrency);
  return nodes;
}

/**
 * Проєкція сирих рядків у детальні (лише обрані columns, за їх key). Колонка у валюті документа —
 * разом із кодом валюти рядка в `__currency` (рендер «344,00 USD»).
 */
export function projectRows(
  rows: Row[],
  columns: string[],
  entity: ReportEntityDef,
  baseCurrency: string,
): DetailRow[] {
  const withCurrency = needsCurrency(entity, columns);
  return rows.map(r => {
    const out: DetailRow = {};
    for (const key of columns) {
      const fld = getField(entity, key);
      out[key] = fieldValue(r, entity, fld.prismaPath, baseCurrency) ?? null;
    }
    if (withCurrency && entity.currencyPath) {
      out.__currency = fieldValue(r, entity, entity.currencyPath, baseCurrency);
    }
    return out;
  });
}

const NUMERIC_COL_TYPES = new Set(['number', 'decimal']);

/** Колонка, яку склеювання підсумовує: число, якому реєстр дозволяє SUM (не ціна, не стан). */
export function isSummable(entity: ReportEntityDef, key: string): boolean {
  const fld = getField(entity, key);
  return NUMERIC_COL_TYPES.has(fld.type) && fld.aggregations.includes('SUM') && !fld.stateNotFlow;
}

/**
 * Склеювання ідентичних детальних рядків (плоский режим, без groupBy): рядки з однаковими
 * значеннями решти колонок згортаються в один; колонки, які можна підсумувати, підсумовуються
 * (з урахуванням signedByType — через numericValue, як у SUM). Так список 334× «Dup1 ×5»
 * стає одним рядком «Dup1 · 1670». Числа без SUM (ціна, собівартість, мін. запас) не
 * складаються — сума цін 49 рядків не є ціною, — а розрізняють рядки, як і текстові колонки.
 * `mergedCount` — скільки сирих рядків склеєно (рендериться у колонці «Склеєно»).
 */
function mergeDetailRows(
  rows: Row[],
  columns: string[],
  entity: ReportEntityDef,
  baseCurrency: string,
): DetailRow[] {
  const numericCols = columns.filter(k => isSummable(entity, k));
  const dimCols = columns.filter(k => !isSummable(entity, k));
  // Валюта документа — ще один вимір: суми різних валют у один рядок не складаються (BR-RPT-029).
  const currencyPath = needsCurrency(entity, columns) ? entity.currencyPath : undefined;
  const buckets = new Map<string, { row: DetailRow; count: number }>();

  for (const r of rows) {
    const dimVals = dimCols.map(k => {
      const fld = getField(entity, k);
      const v = fieldValue(r, entity, fld.prismaPath, baseCurrency) ?? '∅';
      // Дата — до мілісекунди: `String(Date)` рве їх до секунди, і дві різні оплати в одну секунду
      // зливались в один рядок (паритет із SQL-склеюванням, 2026-10-25).
      return v instanceof Date ? v.toISOString() : String(v);
    });
    const currency = currencyPath ? String(fieldValue(r, entity, currencyPath, baseCurrency)) : '';
    const key = [...dimVals, currency].join('');
    let bucket = buckets.get(key);
    if (!bucket) {
      const row: DetailRow = {};
      for (const k of dimCols) {
        row[k] = fieldValue(r, entity, getField(entity, k).prismaPath, baseCurrency) ?? null;
      }
      for (const k of numericCols) row[k] = 0;
      if (currencyPath) row.__currency = currency;
      bucket = { row, count: 0 };
      buckets.set(key, bucket);
    }
    for (const k of numericCols) {
      const v = numericValue(r, entity, k);
      if (v !== null) (bucket.row[k] as number) += v;
    }
    bucket.count += 1;
  }

  return Array.from(buckets.values()).map(b => ({ ...b.row, __mergedCount: b.count }));
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
    /** Базова валюта організації — замість порожньої валюти документа (BR-RPT-029). */
    baseCurrency: string;
  },
  entity: ReportEntityDef,
): ReportResult {
  const { baseCurrency } = config;
  const aggs = config.aggregations ?? [];
  const columns = config.columns ?? [];
  const includeRows = config.includeRows ?? false;
  const sortAlias = config.sortByAggregate?.alias ?? null;
  const sortDir = config.sortByAggregate?.dir ?? 'desc';

  const grandTotals = computeAggs(rows, aggs, entity);
  const grandTotalsByCurrency =
    documentCurrencyAggs(aggs, entity).length > 0
      ? computeByCurrency(rows, aggs, entity, baseCurrency)
      : undefined;
  if (grandTotalsByCurrency) maskMixedCurrency(grandTotals, grandTotalsByCurrency);
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
    baseCurrency,
  );
  // Без групування — детальні рядки на верхньому рівні. Ідентичні рядки СКЛЕЮЮТЬСЯ
  // (mergeDetailRows): однакові за нечисловими колонками → один рядок, числові підсумовуються
  // (список 334× «Dup1 ×5» → «Dup1 · 1670»). Пропускаємо коли columns=[] — інакше шум порожніх.
  const detailRows =
    config.groupBy.length === 0 && includeRows && columns.length > 0
      ? mergeDetailRows(rows, columns, entity, baseCurrency)
      : [];

  return {
    tree,
    detailRows,
    grandTotals,
    ...(grandTotalsByCurrency ? { grandTotalsByCurrency } : {}),
    rowCount: rows.length,
    detailTruncated: rows.length >= REPORT_TAKE_CAP,
    groupsTruncated: false,
    truncated: rows.length >= REPORT_TAKE_CAP,
  };
}
