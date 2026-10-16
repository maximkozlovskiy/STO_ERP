/**
 * Довідник виконавців рядка роботи наряду (BR-WO-018): лише активні механіки. Один запит і один
 * фільтр для картки наряду (`useReferenceData`) і сторінки наряду — обидві пишуть у той самий
 * кеш `cache:employees`, тож вміст кешу однаковий незалежно від того, хто прочитав першим.
 */
export const ACTIVE_MECHANICS_URL = '/employees?limit=200&role=MECHANIC';

interface MechanicRow {
  id: string;
  role?: string;
  status?: string;
  deletedAt?: string | null;
}

/**
 * Активні механіки: не видалені, не звільнені й не у відпустці. Ролі MECHANIC сервер уже віддає
 * лише активних механіків без `role` і `status` (рішення власника 2026-10-16, employee.md), тож
 * відсутнє поле — «пройшло на сервері». `role` перевіряється і тут: кеш, записаний старішою
 * версією сторінки (`/employees` без `role`), містив власника й бухгалтера.
 */
export function activeMechanics<T extends MechanicRow>(
  items: readonly T[] | null | undefined,
): T[] {
  return (items ?? []).filter(
    e =>
      !e.deletedAt &&
      (e.role === undefined || e.role === 'MECHANIC') &&
      (e.status === undefined || e.status === 'ACTIVE'),
  );
}

interface ExecutorRow {
  id: string;
  firstName: string;
  lastName: string;
}

/**
 * Рядки для кешу `cache:employees` — лише id та ім'я. Кеш у `sessionStorage` вкладки виходом не
 * очищується, тож після власника (повна відповідь: телефон, e-mail, дати, `userId`) у тій самій
 * вкладці працював би механік, якому ці поля не віддаються (рішення власника 2026-10-16, друге).
 * Кешуються вже відфільтровані `activeMechanics` — `role`/`status` у кеші не потрібні.
 */
export function executorCacheRows(items: readonly ExecutorRow[]): ExecutorRow[] {
  return items.map(({ id, firstName, lastName }) => ({ id, firstName, lastName }));
}
