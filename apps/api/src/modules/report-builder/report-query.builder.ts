import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import {
  isCalendarDate,
  kyivDayEnd,
  kyivDayStart,
  normalizeKyivDateRange,
} from '../../common/utils/kyiv-date';
import type { ReportEntityDef, ReportFieldDef, FilterOp, FieldType } from './report-registry';
import {
  getEntity,
  getField,
  assertRelationPath,
  relationForPrefix,
  assertEnumValue,
  isDateOnlyPath,
} from './report-registry';

/** Cap проти DoS (як reports.service). Якщо rowCount === take → truncated. */
export const REPORT_TAKE_CAP = 5000;

export interface ReportFilterInput {
  field: string;
  op: FilterOp;
  value?: unknown;
}
export interface ReportSortInput {
  field: string;
  dir: 'asc' | 'desc';
}
export interface ReportConfigInput {
  entity: string;
  columns: string[];
  groupBy: string[];
  filters?: ReportFilterInput[];
  sort?: ReportSortInput[];
  dateRange?: { from: string; to: string };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

export interface BuiltQuery {
  model: string;
  args: { where: Obj; include?: Obj; orderBy: Obj[]; take: number };
}

/**
 * Записує значення у вкладений шлях `where`/`orderBy`. Ключі беруться ВИКЛЮЧНО з реєстрового
 * prismaPath (літерал), не з вводу. Для relation-хопів з softDelete додає deletedAt:null.
 */
function setWherePath(
  where: Obj,
  entity: ReportEntityDef,
  prismaPath: string,
  cond: unknown,
): void {
  const segments = prismaPath.split('.');
  let node = where;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const prefix = segments.slice(0, i + 1).join('.');
    const rel = relationForPrefix(entity, prefix);
    node[seg] = node[seg] ?? {};
    node = node[seg] as Obj;
    // Bug #607: не протікати soft-deleted relation-записи у фільтр.
    if (rel?.targetHasSoftDelete && node['deletedAt'] === undefined) {
      node['deletedAt'] = null;
    }
  }
  node[segments[segments.length - 1]] = cond;
}

/** Чи вже стоїть умова на листку цього шляху (поле вже фільтрується або зайняте періодом). */
function hasWherePath(where: Obj, prismaPath: string): boolean {
  let node: Obj | undefined = where;
  for (const seg of prismaPath.split('.')) {
    if (node === undefined || node === null || typeof node !== 'object') return false;
    node = node[seg] as Obj | undefined;
  }
  return node !== undefined;
}

/** Скільки значень приймає один фільтр `in` (як `@ArrayMaxSize` у DTO — проти роздутого IN). */
export const REPORT_FILTER_IN_MAX = 500;

/** Число в рядку, як його вводить поле «значення» конструктора: «12», «-3», «12.5». */
const NUMERIC_TEXT_RE = /^-?\d+(\.\d+)?$/;

const INVALID = Symbol('invalid');

const UA_DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;

/**
 * День фільтра дати → `YYYY-MM-DD` або null. Приймає ISO-день (так його дає вибір дати) і
 * `ДД.ММ.РРРР` (так його пише людина). Не `Date.parse`: той читає «01.10.2026» як 10 січня
 * (американський порядок), а повна мітка часу як значення «дати» Prisma-колонки не потрібна.
 */
function calendarDay(v: string): string | null {
  const s = v.trim();
  const ua = UA_DATE_RE.exec(s);
  const ymd = ua ? `${ua[3]}-${ua[2]}-${ua[1]}` : s;
  return isCalendarDate(ymd) ? ymd : null;
}

/** Межі дня для поля: київська доба для мітки часу, сама дата для колонки `@db.Date`. */
function dayBounds(ymd: string, dateOnly: boolean): { start: Date; end: Date } {
  if (dateOnly) {
    const d = new Date(`${ymd}T00:00:00.000Z`);
    return { start: d, end: d };
  }
  return { start: kyivDayStart(ymd), end: kyivDayEnd(ymd) };
}

/**
 * Умова по полю дати (BR-RPT-025): значення — день, і оператор порівнює цілими днями. «= 20.10»
 * — увесь день 20.10, «> 20.10» — від 21.10, «≤ 20.10» — до кінця 20.10. Перелік днів (`in`) не
 * підтримується: його не виразити однією умовою поля.
 */
function buildDateCond(
  op: FilterOp,
  ymd: unknown,
  dateOnly: boolean,
  fld: ReportFieldDef,
): unknown {
  if (typeof ymd !== 'string') {
    throw new BadRequestException(
      translateError('err.reportBuilder.filterValueInvalid', getLocale(), { label: fld.label }),
    );
  }
  const { start, end } = dayBounds(ymd, dateOnly);
  switch (op) {
    case 'eq':
      return { gte: start, lte: end };
    case 'ne':
      return { not: { gte: start, lte: end } };
    case 'gt':
      return { gt: end };
    case 'gte':
      return { gte: start };
    case 'lt':
      return { lt: start };
    case 'lte':
      return { lte: end };
    default:
      throw new BadRequestException(
        translateError('err.reportBuilder.disallowedOperator', getLocale(), { op: String(op) }),
      );
  }
}

/**
 * Одне значення фільтра за типом поля → значення для Prisma або INVALID. Лише примітиви: об'єкт
 * чи масив тут — це спроба передати оператор Prisma (`{ startsWith: … }`, `{ not: … }`) повз білий
 * список операторів, тож він не проходить ніколи. Поле «значення» в UI віддає рядок, тому число й
 * так/ні приймаються і рядком: число для цілого поля (`number`) приводиться до Number (Prisma Int
 * рядка не приймає), десяткове (`decimal`) лишається рядком — Prisma Decimal бере його без втрати
 * точності.
 */
function scalarFilterValue(type: FieldType, v: unknown): unknown {
  switch (type) {
    case 'scalar':
    case 'enum':
      return typeof v === 'string' ? v : INVALID;
    case 'number':
      if (typeof v === 'number') return Number.isFinite(v) ? v : INVALID;
      return typeof v === 'string' && NUMERIC_TEXT_RE.test(v.trim()) ? Number(v.trim()) : INVALID;
    case 'decimal':
      if (typeof v === 'number') return Number.isFinite(v) ? v : INVALID;
      return typeof v === 'string' && NUMERIC_TEXT_RE.test(v.trim()) ? v.trim() : INVALID;
    case 'date':
      return typeof v === 'string' ? (calendarDay(v) ?? INVALID) : INVALID;
    case 'boolean':
      if (typeof v === 'boolean') return v;
      return v === 'true' ? true : v === 'false' ? false : INVALID;
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

/**
 * BR-RPT-024: значення фільтра — лише примітив (або масив примітивів для `in`) того типу, що
 * й поле; інакше 400 `err.reportBuilder.filterValueInvalid`. `isNull` значення не потребує:
 * `false` / `'false'` — «заповнено», будь-який інший примітив чи відсутність — «порожньо»;
 * об'єкт чи масив — 400 (UI лишає в `value` введене до зміни оператора — це завжди рядок).
 */
function normalizeFilterValue(op: FilterOp, value: unknown, fld: ReportFieldDef): unknown {
  const invalid = () =>
    new BadRequestException(
      translateError('err.reportBuilder.filterValueInvalid', getLocale(), { label: fld.label }),
    );
  if (op === 'isNull') {
    if (value !== null && typeof value === 'object') throw invalid();
    return value === false || value === 'false' ? false : value;
  }
  if (op === 'in') {
    // Не масив — окрема помилка в buildCond (filterInRequiresArray), як і раніше.
    if (!Array.isArray(value)) return value;
    if (value.length > REPORT_FILTER_IN_MAX) throw invalid();
    return value.map(v => {
      const out = scalarFilterValue(fld.type, v);
      if (out === INVALID) throw invalid();
      return out;
    });
  }
  const out = scalarFilterValue(fld.type, value);
  if (out === INVALID) throw invalid();
  return out;
}

/** Будує Prisma-умову з op + value + типу поля. op з фіксованого whitelist. */
function buildCond(op: FilterOp, value: unknown, fieldType: string): unknown {
  switch (op) {
    case 'eq':
      return value;
    case 'ne':
      return { not: value };
    case 'in':
      if (!Array.isArray(value))
        throw new BadRequestException(
          translateError('err.reportBuilder.filterInRequiresArray', getLocale()),
        );
      return { in: value };
    case 'gt':
      return { gt: value };
    case 'gte':
      return { gte: value };
    case 'lt':
      return { lt: value };
    case 'lte':
      return { lte: value };
    case 'contains':
      if (fieldType !== 'scalar') {
        throw new BadRequestException(
          translateError('err.reportBuilder.filterContainsTextOnly', getLocale()),
        );
      }
      return { contains: String(value), mode: 'insensitive' };
    case 'isNull':
      return value === false ? { not: null } : null;
    default:
      throw new BadRequestException(
        translateError('err.reportBuilder.disallowedOperator', getLocale(), { op: String(op) }),
      );
  }
}

/**
 * Deep-merge relation-шляху у include-дерево. Кореневий рівень — `include` (щоб не тягнути ВСІ
 * скалярні поля кореневої сутності у select — конфлікт з існуючими рядковими скалярами columns).
 *
 * ВСЕРЕДИНІ relation-branch використовуємо ТІЛЬКИ `select` (без `include`), оскільки Prisma не
 * дозволяє `include` і `select` на одному рівні (`Please either use \`include\` or \`select\`, but
 * not both at the same time`). Bug #617: комбо `good.name` + `good.brand.name` — `good.name`
 * створювало `select`, а `good.brand.name` створювало `include` поруч → PrismaClientValidation
 * (400 mute-ловився http-exception.filter).
 *
 * Схема генерації для `good.name` + `good.brand.name`:
 *   { good: { select: { name: true, brand: { select: { name: true } } } } }
 *
 * NB: `where` у nested include/select НЕ дозволений для to-one relation (усі relations тут
 * belongs-to) → Prisma "Unknown argument where". Soft-delete relation-колонок не критичний
 * (рядок уже відфільтрований по deletedAt кореневої сутності; ім'я видаленого зв'язку —
 * прийнятне у звіті). Фільтрація видалених зв'язків у WHERE (setWherePath) — валідна окремо.
 */
function mergeIncludePath(include: Obj, entity: ReportEntityDef, prismaPath: string): void {
  const segments = prismaPath.split('.');
  if (segments.length < 2) return;
  // 1-й хоп — під кореневим `include`, обгортка з `select` (усе всередині — тільки select).
  const firstHop = segments[0];
  include[firstHop] = include[firstHop] ?? { select: {} };
  const firstBranch = include[firstHop] as Obj;
  firstBranch['select'] = firstBranch['select'] ?? {};
  let node = firstBranch['select'] as Obj;
  // проміжні хопи (segments[1..len-2]) → { select: {...} } рекурсивно
  for (let i = 1; i < segments.length - 1; i++) {
    const seg = segments[i];
    // Може вже існувати як leaf (`select: { seg: true }`) — заміняємо на nested select-branch.
    if (node[seg] === true || node[seg] === undefined) node[seg] = { select: {} };
    const branch = node[seg] as Obj;
    branch['select'] = branch['select'] ?? {};
    node = branch['select'] as Obj;
  }
  // leaf — скалярне поле. Не переписуємо існуючу nested-структуру: якщо `name` вже стоїть як
  // { select: {...} } — це неможливо у нашому реєстрі (leaf завжди скаляр), але захисно лишаємо.
  const leaf = segments[segments.length - 1];
  if (node[leaf] === undefined) node[leaf] = true;
}

/** Будує orderBy для (можливо вкладеного) шляху. */
function pathToOrderBy(prismaPath: string, dir: 'asc' | 'desc'): Obj {
  const segments = prismaPath.split('.');
  const root: Obj = {};
  let node = root;
  for (let i = 0; i < segments.length - 1; i++) {
    node[segments[i]] = {};
    node = node[segments[i]] as Obj;
  }
  node[segments[segments.length - 1]] = dir;
  return root;
}

/**
 * config → безпечні Prisma findMany-args. Уся валідність — проти реєстру; orgId + deletedAt
 * інжектяться завжди (deletedAt лише для FULL-профілю). Injection неможливий: ключі з літералів.
 */
export function buildQuery(config: ReportConfigInput, orgId: string): BuiltQuery {
  const entity = getEntity(config.entity);

  const where: Obj = { orgId };
  if (entity.hasSoftDelete) where.deletedAt = null;
  if (entity.parentRelation) where[entity.parentRelation] = { deletedAt: null };

  // dateRange → фільтр по entity.dateField (Kyiv-межі; для `@db.Date` — самі дати)
  if (config.dateRange) {
    const { fromDate, toDate } = normalizeKyivDateRange(config.dateRange.from, config.dateRange.to);
    if (fromDate > toDate) {
      throw new BadRequestException(translateError('err.reportBuilder.startAfterEnd', getLocale()));
    }
    const dateOnly = isDateOnlyPath(entity, entity.dateField);
    where[entity.dateField] = {
      gte: dayBounds(config.dateRange.from, dateOnly).start,
      lte: dayBounds(config.dateRange.to, dateOnly).end,
    };
  }

  // filters — кожен звіряється з реєстром
  for (const f of config.filters ?? []) {
    const fld = getField(entity, f.field);
    if (!fld.filterable)
      throw new BadRequestException(
        translateError('err.reportBuilder.fieldNotFilterable', getLocale(), { label: fld.label }),
      );
    assertRelationPath(entity, fld.prismaPath);
    const value = normalizeFilterValue(f.op, f.value, fld);
    if (fld.type === 'enum' && fld.enumName && f.op !== 'isNull') {
      assertEnumValue(fld.enumName, value);
    }
    const cond =
      fld.type === 'date' && f.op !== 'isNull'
        ? buildDateCond(f.op, value, fld.dateOnly === true, fld)
        : buildCond(f.op, value, fld.type);
    // BR-RPT-022: друга умова на те саме поле (або фільтр по полю дати поверх dateRange) не
    // перезаписує першу, а додається в AND. Раніше `node[leaf] = cond` губив попередню умову:
    // «сума від 100 до 500» показувала все до 500, без жодної помилки.
    if (hasWherePath(where, fld.prismaPath)) {
      const extra: Obj = {};
      setWherePath(extra, entity, fld.prismaPath, cond);
      const and = (where.AND ?? []) as Obj[];
      and.push(extra);
      where.AND = and;
    } else {
      setWherePath(where, entity, fld.prismaPath, cond);
    }
  }

  // include-дерево з relation-полів у columns ∪ groupBy
  const include: Obj = {};
  const relationKeys = new Set<string>([...config.columns, ...config.groupBy]);
  for (const key of relationKeys) {
    const fld = getField(entity, key);
    if (fld.prismaPath.includes('.')) {
      assertRelationPath(entity, fld.prismaPath);
      mergeIncludePath(include, entity, fld.prismaPath);
    }
  }

  // orderBy — whitelist; fallback defaultSort
  const orderBy: Obj[] = [];
  for (const s of config.sort ?? []) {
    const fld = getField(entity, s.field);
    assertRelationPath(entity, fld.prismaPath);
    orderBy.push(pathToOrderBy(fld.prismaPath, s.dir));
  }
  if (orderBy.length === 0) {
    orderBy.push(pathToOrderBy(entity.defaultSort.path, entity.defaultSort.dir));
  }

  const args: BuiltQuery['args'] = { where, orderBy, take: REPORT_TAKE_CAP };
  if (Object.keys(include).length > 0) args.include = include;

  return { model: entity.prismaModel, args };
}
