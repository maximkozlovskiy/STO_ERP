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
  assertEnumValue,
  isDateOnlyPath,
  canBeEmpty,
} from './report-registry';

/**
 * Умови звіту як перелік — ОДНЕ місце валідації конфігу (білі списки, значення за типом, дні дат).
 * З нього два рендерери: Prisma `where` для детальних рядків (`report-query.builder.ts`) і SQL
 * `WHERE` для агрегатів (`report-sql.builder.ts`). Що вони дають ту саму вибірку, стереже
 * `report-builder.parity.integration.spec.ts`.
 */

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

/** Межі значення (будь-яка підмножина): число, рядок-десяткове чи мить дати. */
export interface Bounds {
  gt?: unknown;
  gte?: unknown;
  lt?: unknown;
  lte?: unknown;
}

/** Одна умова на поле `path` (prismaPath з реєстру). */
export type ReportCond =
  | { kind: 'eq'; path: string; value: unknown }
  | { kind: 'ne'; path: string; value: unknown }
  | { kind: 'in'; path: string; values: unknown[] }
  | { kind: 'bounds'; path: string; bounds: Bounds }
  | { kind: 'contains'; path: string; value: string }
  | { kind: 'isNull'; path: string; isNull: boolean }
  /** «≠ день»: поза [start, end] — до початку АБО після кінця (Bug #973). */
  | { kind: 'outside'; path: string; start: unknown; end: unknown };

export interface ReportConditions {
  entity: ReportEntityDef;
  orgId: string;
  /** Зв'язки, на які йде `deletedAt: null` (BR-RPT-007). */
  parentRelations: readonly string[];
  /** Поле-позначка сторно, якщо користувач його не фільтрує (BR-RPT-026). */
  voidedField: string | null;
  /** Період `dateRange` (BR-RPT-009) — першою умовою на `entity.dateField`. */
  dateRange: ReportCond | null;
  /** Фільтри користувача в порядку конфігу. */
  filters: ReportCond[];
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
export function dayBounds(ymd: string, dateOnly: boolean): { start: Date; end: Date } {
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
function dateCond(op: FilterOp, ymd: unknown, dateOnly: boolean, fld: ReportFieldDef): ReportCond {
  if (typeof ymd !== 'string') {
    throw new BadRequestException(
      translateError('err.reportBuilder.filterValueInvalid', getLocale(), { label: fld.label }),
    );
  }
  const path = fld.prismaPath;
  const { start, end } = dayBounds(ymd, dateOnly);
  switch (op) {
    case 'eq':
      return { kind: 'bounds', path, bounds: { gte: start, lte: end } };
    case 'ne':
      return { kind: 'outside', path, start, end };
    case 'gt':
      return { kind: 'bounds', path, bounds: { gt: end } };
    case 'gte':
      return { kind: 'bounds', path, bounds: { gte: start } };
    case 'lt':
      return { kind: 'bounds', path, bounds: { lt: start } };
    case 'lte':
      return { kind: 'bounds', path, bounds: { lte: end } };
    default:
      throw new BadRequestException(
        translateError('err.reportBuilder.disallowedOperator', getLocale(), { op: String(op) }),
      );
  }
}

/**
 * Одне значення фільтра за типом поля → значення для запиту або INVALID. Лише примітиви: об'єкт
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
    // Не масив — окрема помилка в scalarCond (filterInRequiresArray), як і раніше.
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

/**
 * «Містить» шукає текст як є (Bug #976): `%` і `_` — символи шаблону LIKE, і ні Prisma `contains`,
 * ні ILIKE їх не екранують — «Спосіб містить a_h» знаходив «cash», «%» — усі рядки. Екранування
 * зворотною косою (типовий ESCAPE PostgreSQL) діє в обох рендерерах однаково.
 */
export function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, '\\$&');
}

/** Умова з op + нормалізованого значення для недатового поля. op з фіксованого whitelist. */
function scalarCond(op: FilterOp, value: unknown, fld: ReportFieldDef): ReportCond {
  const path = fld.prismaPath;
  switch (op) {
    case 'eq':
      return { kind: 'eq', path, value };
    case 'ne':
      return { kind: 'ne', path, value };
    case 'in':
      if (!Array.isArray(value))
        throw new BadRequestException(
          translateError('err.reportBuilder.filterInRequiresArray', getLocale()),
        );
      return { kind: 'in', path, values: value };
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return { kind: 'bounds', path, bounds: { [op]: value } };
    case 'contains':
      if (fld.type !== 'scalar') {
        throw new BadRequestException(
          translateError('err.reportBuilder.filterContainsTextOnly', getLocale()),
        );
      }
      return { kind: 'contains', path, value: escapeLike(String(value)) };
    case 'isNull':
      return { kind: 'isNull', path, isNull: value !== false };
    default:
      throw new BadRequestException(
        translateError('err.reportBuilder.disallowedOperator', getLocale(), { op: String(op) }),
      );
  }
}

/** Одна умова фільтра користувача з повною перевіркою проти реєстру. */
function filterCond(entity: ReportEntityDef, f: ReportFilterInput): ReportCond {
  const fld = getField(entity, f.field);
  if (!fld.filterable)
    throw new BadRequestException(
      translateError('err.reportBuilder.fieldNotFilterable', getLocale(), { label: fld.label }),
    );
  assertRelationPath(entity, fld.prismaPath);
  // Оператор — до значення: збережений звіт із «містить» на даті інакше чув «Неприпустиме
  // значення», хоча помилка в операторі, а UI такого оператора для дати вже не пропонує.
  if (f.op === 'contains' && fld.type !== 'scalar') {
    throw new BadRequestException(
      translateError('err.reportBuilder.filterContainsTextOnly', getLocale()),
    );
  }
  if (f.op === 'isNull' && !canBeEmpty(entity, fld.prismaPath)) {
    throw new BadRequestException(
      translateError('err.reportBuilder.fieldNotNullable', getLocale(), { label: fld.label }),
    );
  }
  const value = normalizeFilterValue(f.op, f.value, fld);
  if (fld.type === 'enum' && fld.enumName && f.op !== 'isNull') {
    assertEnumValue(fld.enumName, value);
  }
  return fld.type === 'date' && f.op !== 'isNull'
    ? dateCond(f.op, value, fld.dateOnly === true, fld)
    : scalarCond(f.op, value, fld);
}

/** Конфіг → перевірені умови. Кидає 400 на все, що не з реєстру (BR-RPT-001…005, 009, 024, 025). */
export function buildConditions(config: ReportConfigInput, orgId: string): ReportConditions {
  const entity = getEntity(config.entity);
  const voided = entity.voidedField;

  let dateRange: ReportCond | null = null;
  if (config.dateRange) {
    const { fromDate, toDate } = normalizeKyivDateRange(config.dateRange.from, config.dateRange.to);
    if (fromDate > toDate) {
      throw new BadRequestException(translateError('err.reportBuilder.startAfterEnd', getLocale()));
    }
    const dateOnly = isDateOnlyPath(entity, entity.dateField);
    dateRange = {
      kind: 'bounds',
      path: entity.dateField,
      bounds: {
        gte: dayBounds(config.dateRange.from, dateOnly).start,
        lte: dayBounds(config.dateRange.to, dateOnly).end,
      },
    };
  }

  return {
    entity,
    orgId,
    parentRelations: entity.parentRelations ?? [],
    voidedField: voided && !(config.filters ?? []).some(f => f.field === voided) ? voided : null,
    dateRange,
    filters: (config.filters ?? []).map(f => filterCond(entity, f)),
  };
}
