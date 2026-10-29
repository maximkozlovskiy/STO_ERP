import { CALENDAR_DATE_RE } from '@sto/shared';

/**
 * Фільтр списку нарядів з адреси: `?employeeId=…&employeeName=…&dateFrom=…&dateTo=…` — перехід з
 * рядка механіка у звіті «Наряди» (огляд звітів 2026-10-29). Сторінка читає параметри один раз,
 * ставить фільтри й прибирає їх з адреси (як `?action=new`). API фільтр `employeeId` — наряди, де
 * механік виконує хоч один рядок робіт; `dateFrom` / `dateTo` — дата документа.
 */
export interface WorkOrdersUrlFilter {
  /** Виконавець; `name` — підпис фільтра (якщо в адресі його немає — порожній). */
  executor: { id: string; name: string } | null;
  dateFrom: string | null;
  dateTo: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WORK_ORDERS_FILTER_PARAMS = ['employeeId', 'employeeName', 'dateFrom', 'dateTo'];

export function workOrdersFilterHref(
  employee: { id: string; name: string },
  dateFrom: string,
  dateTo: string,
): string {
  const q = new URLSearchParams({
    employeeId: employee.id,
    employeeName: employee.name,
    dateFrom,
    dateTo,
  });
  return `/work-orders?${q}`;
}

/** Розбір параметрів; невалідний id чи дата ігноруються. Жодного валідного — `null`. */
export function parseWorkOrdersUrlFilter(
  get: (key: string) => string | null,
): WorkOrdersUrlFilter | null {
  const id = get('employeeId');
  const executor = id && UUID_RE.test(id) ? { id, name: get('employeeName')?.trim() ?? '' } : null;
  const date = (key: string) => {
    const v = get(key);
    return v && CALENDAR_DATE_RE.test(v) ? v : null;
  };
  const dateFrom = date('dateFrom');
  const dateTo = date('dateTo');
  if (!executor && !dateFrom && !dateTo) return null;
  return { executor, dateFrom, dateTo };
}
