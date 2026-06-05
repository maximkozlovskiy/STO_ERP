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
