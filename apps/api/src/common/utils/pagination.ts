/**
 * Calculates safe skip/take values for Prisma findMany pagination.
 *
 * - Clamps page to minimum 1 (negative/zero page → page 1)
 * - Caps limit at MAX_LIMIT (default 200) to prevent DoS via huge page sizes
 * - Clamps limit to minimum 1
 *
 * Usage:
 *   const { skip, take } = calculatePagination({ page: query.page, limit: query.limit });
 *   await prisma.invoice.findMany({ where, skip, take, orderBy });
 */
export const MAX_PAGE_SIZE = 200;

export function calculatePagination(params: {
  page: number | undefined;
  limit: number | undefined;
  maxLimit?: number;
}): { skip: number; take: number } {
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const cap = params.maxLimit ?? MAX_PAGE_SIZE;
  const take = Math.min(Math.max(1, Math.floor(params.limit ?? 20)), cap);
  return { skip: (page - 1) * take, take };
}

/**
 * Будує Prisma `orderBy` з whitelist дозволених полів сортування.
 *
 * Whitelist-семантика (єдина для всіх list-endpoints):
 * - `sortBy` є у whitelist → сортуємо за мапнутим полем; `sortDir='asc'` інакше 'desc'.
 * - `sortBy` невідоме/порожнє → ПОВНИЙ fallback на `{ [fallback]: 'desc' }`, включно з
 *   напрямом (garbage sortBy не повинен тихо перевертати дефолтний порядок).
 *
 * Nullable-поля (Bug #598): якщо resolved field ∈ `nullableFields` — обгортаємо у
 * `{ sort, nulls: 'last' }`, щоб NULL-и завжди були внизу, незалежно від напряму.
 * Postgres default: ASC → NULLS LAST, DESC → NULLS FIRST — для nullable-полів (paymentDate,
 * completedAt, pricedAt, dueDate) DESC-sort «пустеніє» top списку (сотні draft-записів
 * з null-датами наверху). Задає стабільний UX: NULL = «немає значення» = внизу.
 *
 * Замінює 5 дубльованих inline-ідіом (invoices/purchase-orders/stock-documents/
 * work-orders/supplier-payments findAll) — усуває drift між `in`-check та `?? ''` формами.
 *
 * Usage:
 *   const orderBy = buildSortOrderBy(INV_SORT_FIELDS, sortBy, sortDir);
 *   const orderBy = buildSortOrderBy(PO_SORT_FIELDS, sortBy, sortDir, 'createdAt',
 *                                    new Set(['paymentDate']));
 *   await prisma.invoice.findMany({ where, skip, take, orderBy });
 */
type SortValue = 'asc' | 'desc' | { sort: 'asc' | 'desc'; nulls: 'first' | 'last' };

export function buildSortOrderBy(
  whitelist: Record<string, string>,
  sortBy: string | undefined,
  sortDir: 'asc' | 'desc' | undefined,
  fallback = 'createdAt',
  nullableFields?: ReadonlySet<string>,
): Record<string, SortValue> {
  // `hasOwnProperty`, а не `in` — інакше sortBy='constructor'/'toString' резолвиться
  // у прототипний метод Object.prototype і ламає Prisma orderBy (500).
  const known = sortBy != null && Object.prototype.hasOwnProperty.call(whitelist, sortBy);
  const field = known ? whitelist[sortBy] : fallback;
  const dir: 'asc' | 'desc' = known && sortDir === 'asc' ? 'asc' : 'desc';
  if (nullableFields && nullableFields.has(field)) {
    return { [field]: { sort: dir, nulls: 'last' } };
  }
  return { [field]: dir };
}
