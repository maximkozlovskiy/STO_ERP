import type { Task } from '@/hooks/api/useTasks';
import type { MonthEntry } from './calendar-categories';
import { MONTH_CARD_LIMIT } from './calendar-month';
import { kyivHours, nextDateString, toDateString } from './calendar.utils';

/**
 * Задачі співробітникам у календарі (docs/objects/task.md, BR-TASK-004 / 007): окремий тип —
 * смуга «Задачі» над підйомниками у «Дні» і картки в клітинках «Місяця». Задача НЕ займає
 * підйомник і час механіка: у завантаженість, конфлікти й лічильники категорій не входить.
 */
export type CalendarTask = Pick<
  Task,
  | 'id'
  | 'title'
  | 'status'
  | 'priority'
  | 'assigneeId'
  | 'assigneeName'
  | 'startAt'
  | 'dueAt'
  | 'overdue'
  | 'workOrderNumber'
>;

/** Найдовший проміжок, який календар розкладає по днях (захист від задачі «на рік»). */
const MAX_TASK_DAYS = 62;

/** Проміжок задачі [початок ?? термін, термін ?? початок]; лише термін — точка. Без дат — null. */
export function taskSpan(t: Pick<CalendarTask, 'startAt' | 'dueAt'>): {
  start: string;
  end: string;
} | null {
  const start = t.startAt ?? t.dueAt;
  const end = t.dueAt ?? t.startAt;
  if (!start || !end) return null;
  return { start, end };
}

/** Київські дні `YYYY-MM-DD`, які займає задача (включно); без дат — жодного. */
export function taskDays(t: Pick<CalendarTask, 'startAt' | 'dueAt'>): string[] {
  const span = taskSpan(t);
  if (!span) return [];
  const first = toDateString(new Date(span.start));
  const last = toDateString(new Date(span.end));
  const days = [first];
  for (let d = first; d < last && days.length < MAX_TASK_DAYS;) {
    d = nextDateString(d);
    days.push(d);
  }
  return days;
}

/** Задачі за днями — для клітинок «Місяця» (лише дні з `days`, якщо передано). */
export function tasksByDay<T extends CalendarTask>(
  tasks: readonly T[],
  days?: ReadonlySet<string>,
): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const t of tasks) {
    for (const d of taskDays(t)) {
      if (days && !days.has(d)) continue;
      (out[d] ??= []).push(t);
    }
  }
  return out;
}

/** Задачі одного дня (вид «День»). */
export function tasksOfDay<T extends CalendarTask>(tasks: readonly T[], date: string): T[] {
  return tasks.filter(t => taskDays(t).includes(date));
}

/**
 * Блок задачі в смузі дня `date`, години від початку доби за Києвом, обрізані робочим вікном:
 * задача з попереднього дня починається з відкриття, на наступний — тягнеться до закриття.
 * `point` — лише термін (або початок = термін): позначка в момент терміну.
 */
export function taskDayBlock(
  t: Pick<CalendarTask, 'startAt' | 'dueAt'>,
  date: string,
  windowStart: number,
  windowEnd: number,
): { startH: number; endH: number; point: boolean } | null {
  const span = taskSpan(t);
  if (!span) return null;
  const startDay = toDateString(new Date(span.start));
  const endDay = toDateString(new Date(span.end));
  if (startDay > date || endDay < date) return null;
  const rawStart = startDay < date ? 0 : kyivHours(span.start);
  const rawEnd = endDay > date ? 24 : kyivHours(span.end);
  const clamp = (h: number) => Math.min(Math.max(h, windowStart), windowEnd);
  return {
    startH: clamp(rawStart),
    endH: clamp(rawEnd),
    point: span.start === span.end,
  };
}

/**
 * Доріжки смуги: задачі, що перетинаються в часі (з урахуванням найменшої видимої ширини),
 * лягають на різні доріжки; повертає доріжку кожної задачі й кількість доріжок.
 */
export function layoutTaskLanes(
  blocks: ReadonlyArray<{ id: string; startH: number; endH: number }>,
  minWidthH: number,
): { lanes: Map<string, number>; count: number } {
  const sorted = [...blocks].sort((a, b) => a.startH - b.startH || a.endH - b.endH);
  const laneEnds: number[] = [];
  const lanes = new Map<string, number>();
  for (const b of sorted) {
    const end = Math.max(b.endH, b.startH + minWidthH);
    let lane = laneEnds.findIndex(e => e <= b.startH);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    lanes.set(b.id, lane);
  }
  return { lanes, count: laneEnds.length };
}

/** Стан задачі для кольору смуги: прострочена (BR-TASK-005), виконана, скасована, відкрита. */
export type TaskTone = 'overdue' | 'done' | 'cancelled' | 'open';

export function taskTone(t: Pick<CalendarTask, 'status' | 'overdue'>): TaskTone {
  if (t.status === 'DONE') return 'done';
  if (t.status === 'CANCELLED') return 'cancelled';
  return t.overdue ? 'overdue' : 'open';
}

/** Момент задачі в дні для порядку карток: початок у цей день або початок доби (продовження). */
export function taskMomentOnDay(t: Pick<CalendarTask, 'startAt' | 'dueAt'>, date: string): number {
  const span = taskSpan(t);
  if (!span) return Number.POSITIVE_INFINITY;
  const startMs = new Date(span.start).getTime();
  return toDateString(new Date(span.start)) < date ? Number.NEGATIVE_INFINITY : startMs;
}

export type MonthCellCard =
  { kind: 'slot'; entry: MonthEntry } | { kind: 'task'; task: CalendarTask };

/**
 * Картки клітинки «Місяця»: записи календаря й задачі разом, за часом, не більше
 * `MONTH_CARD_LIMIT`; `more` — скільки лишилось за «ще N» (задачі теж рахуються).
 */
export function monthCellCards(
  entries: readonly MonthEntry[],
  tasks: readonly CalendarTask[],
  date: string,
): { cards: MonthCellCard[]; more: number } {
  const all: Array<{ at: number; card: MonthCellCard }> = [
    ...entries.map(entry => ({
      at: new Date(entry.slot.startAt).getTime(),
      card: { kind: 'slot', entry } as const,
    })),
    ...tasks.map(task => ({
      at: taskMomentOnDay(task, date),
      card: { kind: 'task', task } as const,
    })),
  ];
  all.sort((a, b) => a.at - b.at);
  return {
    cards: all.slice(0, MONTH_CARD_LIMIT).map(x => x.card),
    more: Math.max(0, all.length - MONTH_CARD_LIMIT),
  };
}
