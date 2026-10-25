import type { ReportEntityDef } from './report-registry';
import { getField, assertRelationPath, relationForPrefix } from './report-registry';
import { buildConditions, type ReportCond, type ReportConfigInput } from './report-condition';

export type { ReportConfigInput, ReportFilterInput, ReportSortInput } from './report-condition';
export { REPORT_FILTER_IN_MAX } from './report-condition';

/** Cap проти DoS (як reports.service): детальних рядків не більше; групи й підсумки — SQL без cap. */
export const REPORT_TAKE_CAP = 5000;

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

/** Prisma-значення листка для умови (крім «поза днем» — її рендерить OR). */
function prismaLeaf(cond: Exclude<ReportCond, { kind: 'outside' }>): unknown {
  switch (cond.kind) {
    case 'eq':
      return cond.value;
    case 'ne':
      return { not: cond.value };
    case 'in':
      return { in: cond.values };
    case 'bounds':
      return { ...cond.bounds };
    case 'contains':
      return { contains: cond.value, mode: 'insensitive' };
    case 'isNull':
      return cond.isNull ? null : { not: null };
    default: {
      const _exhaustive: never = cond;
      return _exhaustive;
    }
  }
}

/** Додає умову до `where`: перша на шлях — у сам шлях, наступна — в AND (BR-RPT-022). */
function addCond(where: Obj, entity: ReportEntityDef, cond: ReportCond): void {
  if (cond.kind === 'outside') {
    // «≠ день» — OR двох умов поля (до початку / після кінця): одною умовою поля Prisma його не
    // виражає — `{ not: { gte, lte } }` вона розкладає на NOT(≥) AND NOT(≤), порожня множина
    // (Bug #973). Іде в AND, тож разом із періодом і іншими умовами звужує.
    const branches = [{ lt: cond.start }, { gt: cond.end }].map(c => {
      const branch: Obj = {};
      setWherePath(branch, entity, cond.path, c);
      return branch;
    });
    where.AND = [...((where.AND ?? []) as Obj[]), { OR: branches }];
    return;
  }
  const leaf = prismaLeaf(cond);
  // BR-RPT-022: друга умова на те саме поле (або фільтр по полю дати поверх dateRange) не
  // перезаписує першу, а додається в AND. Раніше `node[leaf] = cond` губив попередню умову:
  // «сума від 100 до 500» показувала все до 500, без жодної помилки.
  if (hasWherePath(where, cond.path)) {
    const extra: Obj = {};
    setWherePath(extra, entity, cond.path, leaf);
    where.AND = [...((where.AND ?? []) as Obj[]), extra];
  } else {
    setWherePath(where, entity, cond.path, leaf);
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
 * config → безпечні Prisma findMany-args. Уся валідність — у `buildConditions` (проти реєстру);
 * orgId + deletedAt інжектяться завжди (deletedAt лише для FULL-профілю). Injection неможливий:
 * ключі з літералів реєстру.
 */
export function buildQuery(config: ReportConfigInput, orgId: string): BuiltQuery {
  const conds = buildConditions(config, orgId);
  const entity = conds.entity;

  const where: Obj = { orgId };
  if (entity.hasSoftDelete) where.deletedAt = null;
  for (const rel of conds.parentRelations) where[rel] = { deletedAt: null };
  if (conds.voidedField) where[conds.voidedField] = null;
  if (conds.dateRange) addCond(where, entity, conds.dateRange);
  for (const cond of conds.filters) addCond(where, entity, cond);

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
