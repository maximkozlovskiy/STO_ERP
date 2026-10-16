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
