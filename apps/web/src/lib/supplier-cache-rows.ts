/** Постачальник у кеші `cache:suppliers` — лише поля вибору. */
export interface SupplierCacheRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}

/**
 * Рядки для кешу `cache:suppliers` — лише id і назва. `GET /counterparties` звужується за роллю
 * (комірник отримує лише постачальників без телефону, e-mail і балансу, BR-CP-014), а кеш у
 * `sessionStorage` вкладки виходом не очищується: без звуження комірник у тій самій вкладці
 * читав би рядки власника з телефонами й балансом.
 */
export function supplierCacheRows(items: readonly SupplierCacheRow[]): SupplierCacheRow[] {
  return items.map(({ id, firstName, lastName, companyName }) => ({
    id,
    firstName: firstName ?? null,
    lastName: lastName ?? null,
    companyName: companyName ?? null,
  }));
}
