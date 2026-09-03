import { BadRequestException } from '@nestjs/common';
import { normalizeKyivDateRange } from '../../common/utils/kyiv-date';
import {
  ReportEntityDef,
  FilterOp,
  getEntity,
  getField,
  assertRelationPath,
  relationForPrefix,
  assertEnumValue,
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

/** Будує Prisma-умову з op + value + типу поля. op з фіксованого whitelist. */
function buildCond(op: FilterOp, value: unknown, fieldType: string): unknown {
  switch (op) {
    case 'eq':
      return value;
    case 'ne':
      return { not: value };
    case 'in':
      if (!Array.isArray(value)) throw new BadRequestException('Фільтр "in" потребує масив');
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
      if (fieldType === 'enum' || fieldType === 'number' || fieldType === 'decimal') {
        throw new BadRequestException('Фільтр "contains" лише для текстових полів');
      }
      return { contains: String(value), mode: 'insensitive' };
    case 'isNull':
      return value === false ? { not: null } : null;
    default:
      throw new BadRequestException(`Недозволений оператор: ${String(op)}`);
  }
}

/** Deep-merge relation-шляху у include-дерево: проміжні → include, лист → select:{leaf:true}. */
function mergeIncludePath(include: Obj, entity: ReportEntityDef, prismaPath: string): void {
  const segments = prismaPath.split('.');
  // leaf = останній сегмент (скалярне поле цільової моделі); гілки = решта.
  let node = include;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const prefix = segments.slice(0, i + 1).join('.');
    const rel = relationForPrefix(entity, prefix);
    node[seg] = node[seg] ?? {};
    const branch = node[seg] as Obj;
    if (rel?.targetHasSoftDelete && branch['where'] === undefined) {
      branch['where'] = { deletedAt: null };
    }
    const isLastHop = i === segments.length - 2;
    if (isLastHop) {
      branch['select'] = branch['select'] ?? {};
      (branch['select'] as Obj)[segments[segments.length - 1]] = true;
    } else {
      branch['include'] = branch['include'] ?? {};
      node = branch['include'] as Obj;
    }
  }
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

  // dateRange → фільтр по entity.dateField (Kyiv-межі)
  if (config.dateRange) {
    const { fromDate, toDate } = normalizeKyivDateRange(config.dateRange.from, config.dateRange.to);
    if (fromDate > toDate) {
      throw new BadRequestException('Дата початку має бути не пізніше дати закінчення');
    }
    where[entity.dateField] = { gte: fromDate, lte: toDate };
  }

  // filters — кожен звіряється з реєстром
  for (const f of config.filters ?? []) {
    const fld = getField(entity, f.field);
    if (!fld.filterable) throw new BadRequestException(`Поле "${fld.label}" не фільтрується`);
    assertRelationPath(entity, fld.prismaPath);
    if (fld.type === 'enum' && fld.enumName && f.op !== 'isNull') {
      assertEnumValue(fld.enumName, f.value);
    }
    const cond = buildCond(f.op, f.value, fld.type);
    setWherePath(where, entity, fld.prismaPath, cond);
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
