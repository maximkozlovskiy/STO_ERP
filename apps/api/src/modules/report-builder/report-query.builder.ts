import type { ReportEntityDef } from './report-registry';
import { getField, assertRelationPath, emptinessOf, needsCurrency } from './report-registry';
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
 * prismaPath (літерал), не з вводу. Видалений пов'язаний запис (контрагент, товар…) — звичайне
 * значення, як і в групуванні (BR-RPT-028): умову `deletedAt` на хоп зв'язку не ставимо (до
 * 2026-10-25 ставили — Bug #607 — і фільтр «= ТОВ X» не бачив платежів видаленого ТОВ X, які група
 * «ТОВ X» показувала). Рядки видаленого документа відсікає `parentRelations`, а не це.
 */
function setWherePath(where: Obj, prismaPath: string, cond: unknown): void {
  const segments = prismaPath.split('.');
  let node = where;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    node[seg] = node[seg] ?? {};
    node = node[seg] as Obj;
  }
  node[segments[segments.length - 1]] = cond;
}

/** Об'єкт `where` з однією умовою на вкладеному шляху. */
function pathWhere(prismaPath: string, cond: unknown): Obj {
  const out: Obj = {};
  setWherePath(out, prismaPath, cond);
  return out;
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
      // Рендерить `emptinessBranches` (зв'язок, NULL, порожній рядок) — сюди не доходить.
      return cond.isNull ? null : { not: null };
    default: {
      const _exhaustive: never = cond;
      return _exhaustive;
    }
  }
}

/**
 * «Порожнє / заповнене» (BR-RPT-028) — рівно ті рядки, що потрапляють у групу «(порожньо)»:
 * немає зв'язку на необов'язковому хопі, колонка NULL або (текст) порожній рядок. Повертає
 * альтернативи як пари «шлях — умова» (для «порожнє» — OR, для «заповнене» — одна).
 */
function emptinessBranches(
  entity: ReportEntityDef,
  path: string,
  isEmpty: boolean,
): { path: string; cond: unknown }[] {
  const e = emptinessOf(entity, path);
  if (isEmpty) {
    return [
      ...e.optionalHops.map(h => ({ path: h, cond: null })),
      ...(e.leafNullable ? [{ path, cond: null }] : []),
      ...(e.text ? [{ path, cond: '' }] : []),
    ];
  }
  // «Заповнене»: умова на листку вимагає й існування всіх зв'язків шляху.
  if (e.text) return [{ path, cond: { not: '' } }];
  if (e.leafNullable) return [{ path, cond: { not: null } }];
  const deepest = e.optionalHops[e.optionalHops.length - 1];
  return deepest ? [{ path: deepest, cond: { isNot: null } }] : [];
}

/** Одна умова на шлях: перша — у сам шлях, наступна — в AND (BR-RPT-022). */
function mergeCond(where: Obj, path: string, leaf: unknown): void {
  // BR-RPT-022: друга умова на те саме поле (або фільтр по полю дати поверх dateRange) не
  // перезаписує першу, а додається в AND. Раніше `node[leaf] = cond` губив попередню умову:
  // «сума від 100 до 500» показувала все до 500, без жодної помилки.
  if (hasWherePath(where, path)) {
    where.AND = [...((where.AND ?? []) as Obj[]), pathWhere(path, leaf)];
  } else {
    setWherePath(where, path, leaf);
  }
}

/** Чи задовольняє базова валюта умову на код валюти (як `COALESCE(код, базова)` у SQL). */
function baseCurrencyMatches(cond: ReportCond, base: string): boolean {
  switch (cond.kind) {
    case 'eq':
      return cond.value === base;
    case 'ne':
      return cond.value !== base;
    case 'in':
      return cond.values.includes(base);
    case 'contains':
      return base.toLowerCase().includes(cond.value.replace(/\\(.)/g, '$1').toLowerCase());
    default:
      return false;
  }
}

/** Додає умову до `where`. */
function addCond(where: Obj, entity: ReportEntityDef, cond: ReportCond, base: string): void {
  if (cond.kind !== 'isNull' && cond.kind !== 'outside' && cond.path === entity.currencyPath) {
    // BR-RPT-029: документ без валюти — у базовій. Умова, під яку підходить базова валюта, бере й
    // рядки без зв'язку з валютою (як `COALESCE(код, базова)` у SQL-агрегатах).
    const missing = emptinessOf(entity, cond.path).optionalHops.map(h => pathWhere(h, null));
    if (missing.length > 0 && baseCurrencyMatches(cond, base)) {
      where.AND = [
        ...((where.AND ?? []) as Obj[]),
        { OR: [pathWhere(cond.path, prismaLeaf(cond)), ...missing] },
      ];
      return;
    }
  }
  if (cond.kind === 'isNull') {
    const branches = emptinessBranches(entity, cond.path, cond.isNull);
    if (branches.length === 1) mergeCond(where, branches[0].path, branches[0].cond);
    else
      where.AND = [
        ...((where.AND ?? []) as Obj[]),
        { OR: branches.map(b => pathWhere(b.path, b.cond)) },
      ];
    return;
  }
  if (cond.kind === 'outside') {
    // «≠ день» — OR двох умов поля (до початку / після кінця): одною умовою поля Prisma його не
    // виражає — `{ not: { gte, lte } }` вона розкладає на NOT(≥) AND NOT(≤), порожня множина
    // (Bug #973). Іде в AND, тож разом із періодом і іншими умовами звужує.
    const branches = [{ lt: cond.start }, { gt: cond.end }].map(c => pathWhere(cond.path, c));
    where.AND = [...((where.AND ?? []) as Obj[]), { OR: branches }];
    return;
  }
  mergeCond(where, cond.path, prismaLeaf(cond));
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
export function buildQuery(
  config: ReportConfigInput,
  orgId: string,
  baseCurrency: string,
): BuiltQuery {
  const conds = buildConditions(config, orgId, baseCurrency);
  const entity = conds.entity;

  const where: Obj = { orgId };
  if (entity.hasSoftDelete) where.deletedAt = null;
  for (const rel of conds.parentRelations) where[rel] = { deletedAt: null };
  if (conds.voidedField) where[conds.voidedField] = null;
  if (conds.dateRange) addCond(where, entity, conds.dateRange, conds.baseCurrency);
  for (const cond of conds.filters) addCond(where, entity, cond, conds.baseCurrency);

  // include-дерево з relation-полів у columns ∪ groupBy
  const include: Obj = {};
  const relationPaths = new Set<string>(
    [...config.columns, ...config.groupBy].map(key => getField(entity, key).prismaPath),
  );
  // Колонка у валюті документа рендериться з кодом валюти рядка (BR-RPT-029).
  if (needsCurrency(entity, config.columns) && entity.currencyPath) {
    relationPaths.add(entity.currencyPath);
  }
  for (const path of relationPaths) {
    if (path.includes('.')) {
      assertRelationPath(entity, path);
      mergeIncludePath(include, entity, path);
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
