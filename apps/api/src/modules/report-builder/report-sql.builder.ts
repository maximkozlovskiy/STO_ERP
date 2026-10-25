import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import type { ReportEntityDef, ReportFieldDef } from './report-registry';
import { getField, isDateOnlyPath } from './report-registry';
import type { ReportCond, ReportConditions } from './report-condition';
import { resolveJoins, type EntityJoins } from './report-joins';
import {
  NON_PHYSICAL_MOVEMENT_TYPES,
  documentCurrencyAggs,
  isSummable,
  needsCurrency,
  type ReportAggInput,
} from './report-aggregator';

/**
 * SQL-агрегати конструктора (групи, «Разом», склеєні плоскі рядки) — точні на будь-якому обсязі,
 * без ліміту детальних рядків (BR-RPT-008, BR-RPT-027). Ті самі умови, що й Prisma `where`
 * детальних рядків (`buildConditions`), рендеряться тут у SQL; паритет стереже
 * `report-builder.parity.integration.spec.ts`.
 *
 * БЕЗПЕКА: ідентифікатори (таблиці, колонки, аліаси) — лише з реєстру й DMMF, і проходять білий
 * список регексом перед `Prisma.raw`; значення — лише параметри `Prisma.sql`. Tenant-guard сирий
 * SQL не бачить (docs/ARCHITECTURE.md), тож `orgId` стоїть на корені й у `ON` кожного з'єднання.
 */

/** Більше груп у відповіді не віддаємо (рядків ROLLUP разом із проміжними рівнями). */
export const REPORT_GROUP_CAP = 20000;
/** Склеєних плоских рядків у відповіді — як детальних. */
export const REPORT_MERGED_CAP = 5000;
/** Рядків розбивки за валютами: групи всіх рівнів × валюти документів (з запасом). */
export const REPORT_CURRENCY_SPLIT_CAP = (REPORT_GROUP_CAP + 1) * 10;

const TABLE_RE = /^[a-z][a-z_]*$/;
const COLUMN_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const ALIAS_RE = /^t\d+$/;

function rawTable(name: string): Prisma.Sql {
  if (!TABLE_RE.test(name)) throw new Error(`report-sql: недопустима назва таблиці ${name}`);
  return Prisma.raw(`"${name}"`);
}

function rawCol(alias: string, column: string): Prisma.Sql {
  if (!ALIAS_RE.test(alias) || !COLUMN_RE.test(column)) {
    throw new Error(`report-sql: недопустимий ідентифікатор ${alias}.${column}`);
  }
  return Prisma.raw(`${alias}."${column}"`);
}

/** Вираз з аліасом виводу: `k0`, `v1`, `d2`. */
function rawAs(expr: Prisma.Sql, alias: string): Prisma.Sql {
  if (!/^[a-z]\d+$/.test(alias)) throw new Error(`report-sql: недопустимий аліас ${alias}`);
  return Prisma.sql`${expr} AS ${Prisma.raw(alias)}`;
}

/** FROM + з'єднання, що знадобились виразам (батько раніше за дитину). */
class SqlScope {
  private readonly joins: EntityJoins;
  private readonly aliases = new Map<string, string>([['', 't0']]);
  private readonly order: string[] = [];

  constructor(
    readonly entity: ReportEntityDef,
    private readonly orgId: string,
    private readonly baseCurrency: string,
  ) {
    this.joins = resolveJoins(entity);
  }

  /** Аліас таблиці хопу `path` (`''` — корінь); підтягує предків. */
  alias(path: string): string {
    const existing = this.aliases.get(path);
    if (existing) return existing;
    const hop = this.joins.hops.get(path);
    if (!hop) throw new Error(`report-sql: зв'язок ${this.entity.key}.${path} не з реєстру`);
    this.alias(hop.parentPath);
    const alias = `t${this.aliases.size}`;
    this.aliases.set(path, alias);
    this.order.push(path);
    return alias;
  }

  /**
   * Колонка поля за prismaPath (`good.brand.name` → `t2."name"`). Код валюти документа —
   * `COALESCE(код, базова)`: порожня валюта = базова валюта організації (BR-RPT-029).
   */
  column(prismaPath: string): Prisma.Sql {
    const segments = prismaPath.split('.');
    const relPath = segments.slice(0, -1).join('.');
    const c = rawCol(this.alias(relPath), segments[segments.length - 1]);
    return prismaPath === this.entity.currencyPath
      ? Prisma.sql`COALESCE(${c}, ${this.baseCurrency})`
      : c;
  }

  /** Код валюти документа з підстановкою базової (сутність має `currencyPath`). */
  currency(): Prisma.Sql {
    if (!this.entity.currencyPath) throw new Error(`report-sql: ${this.entity.key} без валюти`);
    return this.column(this.entity.currencyPath);
  }

  from(): Prisma.Sql {
    const parts: Prisma.Sql[] = [Prisma.sql`FROM ${rawTable(this.joins.rootTable)} t0`];
    for (const path of this.order) {
      const hop = this.joins.hops.get(path);
      if (!hop) continue;
      const a = this.alias(path);
      const p = this.alias(hop.parentPath);
      const org = hop.hasOrgId
        ? Prisma.sql` AND ${rawCol(a, 'orgId')} = ${this.orgId}::uuid`
        : Prisma.empty;
      parts.push(
        Prisma.sql`LEFT JOIN ${rawTable(hop.table)} ${Prisma.raw(a)} ON ${rawCol(a, 'id')} = ${rawCol(p, hop.fk)}${org}`,
      );
    }
    return Prisma.join(parts, ' ');
  }
}

/** Поле реєстру за prismaPath (key = prismaPath у всьому реєстрі) або undefined (поле періоду). */
function fieldByPath(entity: ReportEntityDef, prismaPath: string): ReportFieldDef | undefined {
  return entity.fields.find(f => f.prismaPath === prismaPath);
}

/** `YYYY-MM-DD` для межі колонки `@db.Date` (межа — опівніч UTC, `dayBounds`). */
const ymd = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));

/** Значення-параметр з приведенням під тип колонки. */
function param(fld: ReportFieldDef | undefined, dateOnly: boolean, v: unknown): Prisma.Sql {
  if (dateOnly) return Prisma.sql`${ymd(v)}::date`;
  if (fld?.type === 'decimal') return Prisma.sql`${String(v)}::numeric`;
  return Prisma.sql`${v}`;
}

/** Колонка під порівняння: enum — як текст (значення вже звірені з білим списком). */
function operand(scope: SqlScope, fld: ReportFieldDef | undefined, path: string): Prisma.Sql {
  const c = scope.column(path);
  return fld?.type === 'enum' ? Prisma.sql`${c}::text` : c;
}

function condSql(scope: SqlScope, cond: ReportCond): Prisma.Sql {
  const entity = scope.entity;
  const fld = fieldByPath(entity, cond.path);
  const dateOnly = isDateOnlyPath(entity, cond.path);
  const c = operand(scope, fld, cond.path);
  const p = (v: unknown) => param(fld, dateOnly, v);
  switch (cond.kind) {
    case 'eq':
      return Prisma.sql`${c} = ${p(cond.value)}`;
    case 'ne':
      return Prisma.sql`${c} <> ${p(cond.value)}`;
    case 'in': {
      if (cond.values.length === 0) return Prisma.sql`FALSE`;
      return Prisma.sql`${c} IN (${Prisma.join(cond.values.map(p))})`;
    }
    case 'bounds': {
      const parts: Prisma.Sql[] = [];
      const { gt, gte, lt, lte } = cond.bounds;
      if (gt !== undefined) parts.push(Prisma.sql`${c} > ${p(gt)}`);
      if (gte !== undefined) parts.push(Prisma.sql`${c} >= ${p(gte)}`);
      if (lt !== undefined) parts.push(Prisma.sql`${c} < ${p(lt)}`);
      if (lte !== undefined) parts.push(Prisma.sql`${c} <= ${p(lte)}`);
      return Prisma.join(parts, ' AND ');
    }
    case 'contains':
      // Як Prisma `contains` + `mode: 'insensitive'` на PostgreSQL (паритет — інтеграційний тест).
      return Prisma.sql`${c} ILIKE ${`%${cond.value}%`}`;
    case 'isNull':
      // BR-RPT-028: «порожнє» = група «(порожньо)»: NULL (зокрема немає зв'язку — LEFT JOIN дає
      // NULL) або порожній рядок тексту; «заповнене» — решта.
      if (fld?.type === 'scalar') {
        return cond.isNull ? Prisma.sql`(${c} IS NULL OR ${c} = '')` : Prisma.sql`${c} <> ''`;
      }
      return cond.isNull ? Prisma.sql`${c} IS NULL` : Prisma.sql`${c} IS NOT NULL`;
    case 'outside':
      return Prisma.sql`(${c} < ${p(cond.start)} OR ${c} > ${p(cond.end)})`;
    default: {
      const _exhaustive: never = cond;
      return _exhaustive;
    }
  }
}

/** WHERE з умов: системні (org, soft delete, документ-власник, сторно, період) + фільтри. */
function whereSql(scope: SqlScope, conds: ReportConditions): Prisma.Sql {
  const entity = conds.entity;
  const parts: Prisma.Sql[] = [Prisma.sql`t0."orgId" = ${conds.orgId}::uuid`];
  if (entity.hasSoftDelete) parts.push(Prisma.sql`t0."deletedAt" IS NULL`);
  for (const rel of conds.parentRelations) {
    const a = scope.alias(rel);
    parts.push(Prisma.sql`${rawCol(a, 'id')} IS NOT NULL AND ${rawCol(a, 'deletedAt')} IS NULL`);
  }
  if (conds.voidedField) parts.push(Prisma.sql`${scope.column(conds.voidedField)} IS NULL`);
  for (const cond of [...(conds.dateRange ? [conds.dateRange] : []), ...conds.filters]) {
    // Без умов на хоп зв'язку: значення на LEFT JOIN без зв'язку — NULL, і порівняння його відсікає
    // так само, як Prisma-фільтр по зв'язку; видалений пов'язаний запис — звичайне значення (028).
    parts.push(condSql(scope, cond));
  }
  return Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}`;
}

/** Ключ групи: день — `YYYY-MM-DD` за Києвом (BR-RPT-010), інше — текст; порожній рядок = NULL. */
function groupKeySql(scope: SqlScope, fld: ReportFieldDef): Prisma.Sql {
  const c = scope.column(fld.prismaPath);
  if (fld.type === 'date') {
    // Колонки — timestamp без поясу в UTC: подвійний AT TIME ZONE, як reports.service (Bug #808).
    return fld.dateOnly
      ? Prisma.sql`to_char(${c}, 'YYYY-MM-DD')`
      : Prisma.sql`to_char((${c} AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD')`;
  }
  return Prisma.sql`NULLIF(${c}::text, '')`;
}

/** Вхід агрегації на рядок: знакова кількість (BR-RPT-014), дата → мс, число → numeric. */
function aggInputSql(scope: SqlScope, fld: ReportFieldDef): Prisma.Sql {
  const c = scope.column(fld.prismaPath);
  if (fld.type === 'date') return Prisma.sql`(EXTRACT(EPOCH FROM ${c}) * 1000)`;
  if (fld.signedByType) {
    const t = Prisma.sql`${scope.column(fld.signedByType)}::text`;
    const nonPhysical = Prisma.join([...NON_PHYSICAL_MOVEMENT_TYPES].map(v => Prisma.sql`${v}`));
    return Prisma.sql`(CASE WHEN ${t} IN (${nonPhysical}) THEN NULL WHEN ${t} = ${'WRITEOFF'} THEN -ABS(${c}::numeric) ELSE ${c}::numeric END)`;
  }
  return Prisma.sql`${c}::numeric`;
}

function aggFnSql(agg: ReportAggInput['agg'], input: Prisma.Sql): Prisma.Sql {
  switch (agg) {
    case 'SUM':
      return Prisma.sql`COALESCE(SUM(${input}), 0)`;
    case 'AVG':
      return Prisma.sql`AVG(${input})`;
    case 'MIN':
      return Prisma.sql`MIN(${input})`;
    case 'MAX':
      return Prisma.sql`MAX(${input})`;
    case 'COUNT':
      return Prisma.sql`COUNT(*)`;
    default: {
      const _exhaustive: never = agg;
      return _exhaustive;
    }
  }
}

/** groupBy — лише поля з `groupable` (раніше прапорець перевіряв тільки UI). */
export function assertGroupable(entity: ReportEntityDef, groupBy: string[]): ReportFieldDef[] {
  return groupBy.map(key => {
    const fld = getField(entity, key);
    if (!fld.groupable) {
      throw new BadRequestException(
        translateError('err.reportBuilder.fieldNotGroupable', getLocale(), { label: fld.label }),
      );
    }
    return fld;
  });
}

/**
 * Порядок рядків групових агрегатів перед LIMIT: рівнем (сума GROUPING спадає — «Разом», далі рівень
 * 1, 2…), усередині рівня — ключами. Ключі роблять зріз детермінованим: ROLLUP і розбивка за
 * валютами (`buildCurrencySplitSql`) відрізають ОДНІ Й ТІ САМІ найглибші групи, а не кожен свої.
 */
function levelOrderSql(keyList: string[]): string {
  return `${keyList.map(k => `GROUPING(${k})`).join(' + ')} DESC, ${keyList.join(', ')}`;
}

/**
 * Групи всіх рівнів + «Разом» одним запитом: `GROUP BY ROLLUP(k0…kn)`. Рядок має ключі `k{i}`,
 * прапорці `g{i}` (1 — рівень вище цього ключа), `n` (кількість рядків) і агрегати `v{j}`.
 * Без групування — один рядок із «Разом».
 */
export function buildAggregateSql(
  conds: ReportConditions,
  groupBy: ReportFieldDef[],
  aggs: ReportAggInput[],
): Prisma.Sql {
  const scope = new SqlScope(conds.entity, conds.orgId, conds.baseCurrency);
  const keys = groupBy.map((f, i) => rawAs(groupKeySql(scope, f), `k${i}`));
  const inputs = aggs.map((a, j) =>
    rawAs(aggInputSql(scope, getField(conds.entity, a.field)), `v${j}`),
  );
  const where = whereSql(scope, conds);
  const inner = Prisma.join([Prisma.sql`1 AS one`, ...keys, ...inputs], ', ');
  const outerKeys = groupBy.flatMap((_, i) => [
    Prisma.raw(`k${i}`),
    Prisma.raw(`GROUPING(k${i}) AS g${i}`),
  ]);
  const outerAggs = aggs.map(
    (a, j) => Prisma.sql`${aggFnSql(a.agg, Prisma.raw(`v${j}`))}::text AS ${Prisma.raw(`a${j}`)}`,
  );
  const select = Prisma.join([...outerKeys, Prisma.sql`COUNT(*)::int AS n`, ...outerAggs], ', ');
  // ORDER BY рівнем (сума GROUPING спадає: «Разом», далі рівень 1, 2…): ROLLUP хешується й віддає
  // рядки в довільному порядку, і LIMIT на перевищенні ліміту відрізав би «Разом» чи батьківські
  // групи (rowCount 0, діти-сироти). Так відрізаються лише найглибші групи.
  const keyList = groupBy.map((_, i) => `k${i}`);
  const group = groupBy.length
    ? Prisma.sql`GROUP BY ROLLUP (${Prisma.raw(keyList.join(', '))}) ORDER BY ${Prisma.raw(levelOrderSql(keyList))} LIMIT ${REPORT_GROUP_CAP + 1}`
    : Prisma.empty;
  // FROM будується після виразів: з'єднання додаються, коли вирази звертаються до зв'язків.
  return Prisma.sql`SELECT ${select} FROM (SELECT ${inner} ${scope.from()} ${where}) s ${group}`;
}

/**
 * Розбивка агрегацій у валюті документа за валютою (BR-RPT-029): ті самі умови, `GROUP BY GROUPING
 * SETS ((cur), (k0, cur), …, (k0…kn-1, cur))`. Рядок має ключі `k{i}` (NULL вище свого рівня),
 * прапорці `g{i}`, код `cur` і агрегати `a{j}` у порядку `documentCurrencyAggs`. Порожній, якщо
 * таких агрегацій у звіті немає.
 */
export function buildCurrencySplitSql(
  conds: ReportConditions,
  groupBy: ReportFieldDef[],
  aggs: ReportAggInput[],
): Prisma.Sql | null {
  const docAggs = documentCurrencyAggs(aggs, conds.entity);
  if (docAggs.length === 0) return null;
  const scope = new SqlScope(conds.entity, conds.orgId, conds.baseCurrency);
  const keys = groupBy.map((f, i) => rawAs(groupKeySql(scope, f), `k${i}`));
  const inputs = docAggs.map((a, j) =>
    rawAs(aggInputSql(scope, getField(conds.entity, a.field)), `v${j}`),
  );
  const cur = rawAs(scope.currency(), 'c0');
  const where = whereSql(scope, conds);
  const inner = Prisma.join([cur, ...keys, ...inputs], ', ');
  const outerKeys = groupBy.flatMap((_, i) => [
    Prisma.raw(`k${i}`),
    Prisma.raw(`GROUPING(k${i}) AS g${i}`),
  ]);
  const outerAggs = docAggs.map(
    (a, j) => Prisma.sql`${aggFnSql(a.agg, Prisma.raw(`v${j}`))}::text AS ${Prisma.raw(`a${j}`)}`,
  );
  const select = Prisma.join([...outerKeys, Prisma.raw('c0 AS cur'), ...outerAggs], ', ');
  // Набір на кожен рівень дерева разом із «Разом»: (c0), (k0, c0), …, (k0…kn-1, c0).
  const keyList = groupBy.map((_, i) => `k${i}`);
  const sets = keyList.map((_, l) => [...keyList.slice(0, l), 'c0']).concat([[...keyList, 'c0']]);
  const levelOrder = keyList.length ? ` ORDER BY ${levelOrderSql(keyList)}` : '';
  // Ліміт — як у групах, помножений на валюти. Порядок той самий, що в ROLLUP (`levelOrderSql`):
  // обидва запити відрізають той самий хвіст найглибших груп, тож групи, що лишились у дереві,
  // мають свою розбивку (групу без розбивки `assembleTree` показує без спільного числа).
  const group = Prisma.raw(
    `GROUP BY GROUPING SETS (${sets.map(set => `(${set.join(', ')})`).join(', ')})${levelOrder} LIMIT ${REPORT_CURRENCY_SPLIT_CAP}`,
  );
  return Prisma.sql`SELECT ${select} FROM (SELECT ${inner} ${scope.from()} ${where}) s ${group}`;
}

/**
 * Склеєні плоскі рядки (BR-RPT-015) — у БД: `GROUP BY` колонок, яких не підсумовують, і SUM тих,
 * яких підсумовують; `n` — скільки рядків склеєно. Порядок — як перша поява рядка у вибірці
 * детальних рядків (`MAX(createdAt)` для спадання).
 */
export function buildMergedRowsSql(
  conds: ReportConditions,
  columns: string[],
  sort: { field: string; dir: 'asc' | 'desc' } | null,
): Prisma.Sql {
  const scope = new SqlScope(conds.entity, conds.orgId, conds.baseCurrency);
  const entity = conds.entity;
  const dims = columns.filter(k => !isSummable(entity, k));
  const sums = columns.filter(k => isSummable(entity, k));
  const dimExprs = dims.map((k, i) => rawAs(scope.column(getField(entity, k).prismaPath), `d${i}`));
  // Валюта документа — ще один вимір: суми різних валют у один рядок не складаються (BR-RPT-029).
  const withCurrency = needsCurrency(entity, columns);
  if (withCurrency) dimExprs.push(rawAs(scope.currency(), 'c0'));
  const sumExprs = sums.map((k, i) =>
    rawAs(Prisma.sql`COALESCE(SUM(${aggInputSql(scope, getField(entity, k))}), 0)::text`, `s${i}`),
  );
  const sortPath = sort ? getField(entity, sort.field).prismaPath : entity.defaultSort.path;
  const sortDir = sort ? sort.dir : entity.defaultSort.dir;
  const sortExpr = scope.column(sortPath);
  const orderAgg = sortDir === 'asc' ? Prisma.sql`MIN(${sortExpr})` : Prisma.sql`MAX(${sortExpr})`;
  const orderDir = Prisma.raw(sortDir === 'asc' ? 'ASC' : 'DESC');
  const where = whereSql(scope, conds);
  const select = Prisma.join([...dimExprs, ...sumExprs, Prisma.sql`COUNT(*)::int AS n`], ', ');
  // Без жодної непідсумовуваної колонки агрегат без GROUP BY дає рядок і над порожньою вибіркою —
  // фантомний «0 · склеєно 0»; JS-склеювання давало порожній список.
  const group = dimExprs.length
    ? Prisma.sql`GROUP BY ${Prisma.raw(dimExprs.map((_, i) => String(i + 1)).join(', '))}`
    : Prisma.sql`HAVING COUNT(*) > 0`;
  return Prisma.sql`SELECT ${select} ${scope.from()} ${where} ${group} ORDER BY ${orderAgg} ${orderDir} NULLS LAST LIMIT ${REPORT_MERGED_CAP + 1}`;
}

/** Імена виводу для читання рядків результату. */
export const mergedDimAlias = (i: number) => `d${i}`;
export const mergedSumAlias = (i: number) => `s${i}`;
