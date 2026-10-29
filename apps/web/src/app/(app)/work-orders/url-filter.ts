import { CALENDAR_DATE_RE, WO_STATUS_LABELS } from '@sto/shared';

/**
 * Фільтр списку нарядів з адреси: `?employeeId=…&employeeName=…&dateFrom=…&dateTo=…` — перехід з
 * рядка механіка у звіті «Наряди» (огляд звітів 2026-10-29). Сторінка читає параметри один раз,
 * ставить фільтри й прибирає їх з адреси (як `?action=new`). API фільтр `employeeId` — наряди, де
 * механік виконує хоч один рядок робіт; `dateFrom` / `dateTo` — дата документа.
 *
 * `?status=IN_PROGRESS,ON_HOLD` — перехід із карток дашборду «В роботі» / «Очікують» (UX-огляд
 * 2026-10-29): набір статусів той самий, що рахує картка. Картки рахують наряди за весь час, тож
 * без дат в адресі типовий період «сьогодні» знімається — інакше список показав би менше, ніж число
 * на картці.
 */
export interface WorkOrdersUrlFilter {
  /** Виконавець; `name` — підпис фільтра (якщо в адресі його немає — порожній). */
  executor: { id: string; name: string } | null;
  /** `null` — не чіпати; `''` — зняти межу (перехід із дашборду без дат). */
  dateFrom: string | null;
  dateTo: string | null;
  /** Статуси (один чи кілька); `null` — фільтр статусу з адреси не задано. */
  statuses: string[] | null;
}

/** «В роботі» на дашборді — ті самі статуси, що `activeWo` сервера. */
export const WO_IN_WORK_STATUSES: readonly string[] = Object.freeze(['IN_PROGRESS', 'ON_HOLD']);

/** Наряди звіту «Наряди» — усі статуси, крім скасованого (BR-RPT-031; чернетки — рахуються). */
export const WO_REPORT_STATUSES: readonly string[] = Object.freeze(
  Object.keys(WO_STATUS_LABELS).filter(s => s !== 'CANCELLED'),
);

/** Набір статусів фільтра — саме «усі, крім скасованих» (підпис чипа — коротко, не 9 назв). */
export function isReportStatusSet(statuses: readonly string[]): boolean {
  return (
    statuses.length === WO_REPORT_STATUSES.length &&
    WO_REPORT_STATUSES.every(s => statuses.includes(s))
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WORK_ORDERS_FILTER_PARAMS = [
  'employeeId',
  'employeeName',
  'dateFrom',
  'dateTo',
  'status',
];

/** Список нарядів, відфільтрований за статусами (картки дашборду). */
export function workOrdersStatusHref(statuses: readonly string[]): string {
  return `/work-orders?${new URLSearchParams({ status: statuses.join(',') })}`;
}

/**
 * Наряди механіка за період звіту «Наряди»: виконавець, дата документа і той самий відбір статусів,
 * що рахує звіт (без скасованих, BR-RPT-031) — список збігається зі звітом.
 */
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
    status: WO_REPORT_STATUSES.join(','),
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
  const parsed = [...new Set((get('status') ?? '').split(',').map(v => v.trim()))].filter(
    v => v in WO_STATUS_LABELS,
  );
  const statuses = parsed.length ? parsed : null;
  let dateFrom = date('dateFrom');
  let dateTo = date('dateTo');
  if (!executor && !dateFrom && !dateTo && !statuses) return null;
  if (statuses && !get('dateFrom') && !get('dateTo')) {
    dateFrom = '';
    dateTo = '';
  }
  return { executor, dateFrom, dateTo, statuses };
}
