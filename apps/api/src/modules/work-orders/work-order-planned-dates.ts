import { kyivMinuteOfDay, type WorkHours } from '../../common/utils/work-hours';

/** Планові дати наряду: `plannedAt` — початок, `dueDate` — завершення. */
export interface PlannedDates {
  plannedAt: Date | null;
  dueDate: Date | null;
}

export type PlannedDatesError =
  | { key: 'err.workOrder.plannedInPast' }
  | { key: 'err.workOrder.plannedOutsideWorkHours'; params: { start: string; end: string } }
  | { key: 'err.workOrder.plannedEndBeforeStart' };

const pad2 = (h: number): string => String(h).padStart(2, '0');

/** Та сама мить (або обидві дати порожні). */
export const sameInstant = (a: Date | null, b: Date | null): boolean =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

/** Які з планових дат змінюються відносно збережених (`prev = null` — новий наряд). */
export function changedPlannedDates(
  next: PlannedDates,
  prev: PlannedDates | null,
): { start: boolean; end: boolean } {
  return {
    start:
      next.plannedAt !== null && (prev === null || !sameInstant(next.plannedAt, prev.plannedAt)),
    end: next.dueDate !== null && (prev === null || !sameInstant(next.dueDate, prev.dueDate)),
  };
}

/**
 * Початок — у робочому вікні й раніше за закриття (`[start, end)`); завершення — у вікні
 * включно з годиною закриття (`[start, end]`): «до 18:00» — останній робочий момент дня.
 */
function withinWorkHours(d: Date, hours: WorkHours, edge: 'start' | 'end'): boolean {
  const m = kyivMinuteOfDay(d);
  const open = hours.startHour * 60;
  const close = hours.endHour * 60;
  return edge === 'start' ? m >= open && m < close : m >= open && m <= close;
}

/**
 * BR-WO-019: планові початок і завершення — не раніше поточного моменту і в робочих годинах філії
 * наряду (київський час), завершення пізніше за початок. Перевіряються лише значення, що
 * змінюються відносно збережених: старий наряд із минулими датами зберігається, якщо їх не
 * чіпали. Повертає першу порушену умову або `null`.
 */
export function plannedDatesError(
  next: PlannedDates,
  prev: PlannedDates | null,
  now: Date,
  hours: WorkHours,
): PlannedDatesError | null {
  const changed = changedPlannedDates(next, prev);
  const touched: [Date, 'start' | 'end'][] = [];
  if (changed.start) touched.push([next.plannedAt!, 'start']);
  if (changed.end) touched.push([next.dueDate!, 'end']);
  if (touched.length === 0) return null;

  if (touched.some(([d]) => d.getTime() < now.getTime())) {
    return { key: 'err.workOrder.plannedInPast' };
  }
  if (touched.some(([d, edge]) => !withinWorkHours(d, hours, edge))) {
    return {
      key: 'err.workOrder.plannedOutsideWorkHours',
      params: { start: pad2(hours.startHour), end: pad2(hours.endHour) },
    };
  }
  if (next.plannedAt && next.dueDate && next.dueDate.getTime() <= next.plannedAt.getTime()) {
    return { key: 'err.workOrder.plannedEndBeforeStart' };
  }
  return null;
}
