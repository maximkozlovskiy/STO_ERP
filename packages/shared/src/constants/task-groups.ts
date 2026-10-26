/**
 * Групування й форматування задач співробітникам (BR-TASK-005) — чиста логіка без React і
 * платформи. Користується планшет механіка (`apps/mobile`, вкладка «Задачі»), де свого раннера
 * тестів немає, тому правила й тести живуть тут.
 *
 * Час: мітки часу з API — UTC. «Сьогодні» і показ часу — за Києвом (DST через
 * `Intl.DateTimeFormat` з `timeZone`, без зашитого зсуву +02/+03).
 */

import { TIMEZONE } from '../constants';

/** Мітка часу в будь-якій формі, яку дають API (ISO-рядок) і WatermelonDB (мс). */
export type TaskTimeLike = string | number | Date | null | undefined;

/** Статуси, у яких задача ще відкрита: лише вони можуть бути прострочені (BR-TASK-005). */
export const OPEN_TASK_STATUS_VALUES: readonly string[] = Object.freeze(['NEW', 'IN_PROGRESS']);

export type TaskGroupKey = 'OVERDUE' | 'TODAY' | 'LATER' | 'NO_DUE' | 'DONE';

/** Порядок груп у списку «Мої задачі». */
export const TASK_GROUP_ORDER: readonly TaskGroupKey[] = Object.freeze([
  'OVERDUE',
  'TODAY',
  'LATER',
  'NO_DUE',
  'DONE',
]);

export const TASK_GROUP_LABELS: Record<TaskGroupKey, string> = {
  OVERDUE: 'Прострочені',
  TODAY: 'Сьогодні',
  LATER: 'Далі',
  NO_DUE: 'Без терміну',
  DONE: 'Виконані',
};

/** Вага пріоритету для сортування: вищий пріоритет — вище в групі. */
export const TASK_PRIORITY_RANK: Record<string, number> = {
  URGENT: 3,
  HIGH: 2,
  NORMAL: 1,
  LOW: 0,
};

/** Мітка часу → мс; порожня чи невалідна → `null`. */
export function taskTimeMs(t: TaskTimeLike): number | null {
  if (t === null || t === undefined || t === '') return null;
  const ms = t instanceof Date ? t.getTime() : typeof t === 'number' ? t : new Date(t).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Module-level: створення Intl.DateTimeFormat дороге (ініціалізація локалі) — не в циклі.
// `hourCycle: 'h23'`, а не `hour12: false`: частина рушіїв друкує північ як «24:00».
// Частини беруться через formatToParts — їхні типи не залежать від локалі пристрою.
const KYIV_PARTS_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

interface KyivParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

function kyivParts(ms: number): KyivParts {
  const out: KyivParts = { year: '', month: '', day: '', hour: '', minute: '' };
  for (const p of KYIV_PARTS_FMT.formatToParts(new Date(ms))) {
    if (p.type === 'year' || p.type === 'month' || p.type === 'day') out[p.type] = p.value;
    else if (p.type === 'hour' || p.type === 'minute') out[p.type] = p.value;
  }
  return out;
}

/** Київська календарна дата `YYYY-MM-DD` мітки часу; порожня чи невалідна → `''`. */
export function kyivDayKey(t: TaskTimeLike): string {
  const ms = taskTimeMs(t);
  if (ms === null) return '';
  const p = kyivParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

/** `DD.MM.YYYY HH:mm` за Києвом; порожня чи невалідна мітка → `''`. */
export function formatKyivDateTime(t: TaskTimeLike): string {
  const ms = taskTimeMs(t);
  if (ms === null) return '';
  const p = kyivParts(ms);
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

export interface TaskGroupInput {
  status: string;
  dueAt: TaskTimeLike;
  priority?: string | null;
  completedAt?: TaskTimeLike;
}

/**
 * BR-TASK-005: прострочена = термін минув (`dueAt < now`, строго) і статус NEW або IN_PROGRESS.
 * Дзеркало серверного `isTaskOverdue` (`apps/api/src/modules/tasks/tasks.service.ts`), щоб
 * планшет без мережі показував прострочення так само, як сервер.
 */
export function isTaskOverdueAt(
  task: Pick<TaskGroupInput, 'status' | 'dueAt'>,
  now: Date,
): boolean {
  const due = taskTimeMs(task.dueAt);
  return due !== null && due < now.getTime() && OPEN_TASK_STATUS_VALUES.includes(task.status);
}

/**
 * Група задачі відносно `now`:
 * - `DONE` — виконана (незалежно від терміну);
 * - `OVERDUE` — відкрита, термін минув (BR-TASK-005);
 * - `TODAY` — відкрита, термін сьогодні за Києвом і ще не минув;
 * - `LATER` — відкрита, термін у наступні дні за Києвом;
 * - `NO_DUE` — відкрита, терміну немає.
 * Скасована (і будь-який невідомий статус) — `null`: у списку механіка її немає.
 */
export function taskGroupOf(task: TaskGroupInput, now: Date): TaskGroupKey | null {
  if (task.status === 'DONE') return 'DONE';
  if (!OPEN_TASK_STATUS_VALUES.includes(task.status)) return null;
  const due = taskTimeMs(task.dueAt);
  if (due === null) return 'NO_DUE';
  if (isTaskOverdueAt(task, now)) return 'OVERDUE';
  return kyivDayKey(due) === kyivDayKey(now) ? 'TODAY' : 'LATER';
}

export interface TaskGroup<T> {
  key: TaskGroupKey;
  label: string;
  items: T[];
}

function priorityRank(p: string | null | undefined): number {
  return TASK_PRIORITY_RANK[p ?? ''] ?? 1;
}

function compareByDue(a: TaskGroupInput, b: TaskGroupInput): number {
  const da = taskTimeMs(a.dueAt) ?? Number.POSITIVE_INFINITY;
  const db = taskTimeMs(b.dueAt) ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da < db ? -1 : 1;
  return priorityRank(b.priority) - priorityRank(a.priority);
}

function compareByPriority(a: TaskGroupInput, b: TaskGroupInput): number {
  return priorityRank(b.priority) - priorityRank(a.priority);
}

function compareByCompletedDesc(a: TaskGroupInput, b: TaskGroupInput): number {
  const ca = taskTimeMs(a.completedAt) ?? Number.NEGATIVE_INFINITY;
  const cb = taskTimeMs(b.completedAt) ?? Number.NEGATIVE_INFINITY;
  if (ca === cb) return 0;
  return ca > cb ? -1 : 1;
}

/**
 * Розкладає задачі на групи в порядку `TASK_GROUP_ORDER`; порожні групи не повертаються.
 * Усередині: прострочені, сьогодні й далі — за терміном (раніший вище), за рівного терміну —
 * за пріоритетом; без терміну — за пріоритетом; виконані — щойно виконані вище.
 */
export function groupTasksByDue<T extends TaskGroupInput>(
  tasks: readonly T[],
  now: Date,
): TaskGroup<T>[] {
  const buckets: Record<TaskGroupKey, T[]> = {
    OVERDUE: [],
    TODAY: [],
    LATER: [],
    NO_DUE: [],
    DONE: [],
  };
  for (const t of tasks) {
    const key = taskGroupOf(t, now);
    if (key) buckets[key].push(t);
  }
  buckets.OVERDUE.sort(compareByDue);
  buckets.TODAY.sort(compareByDue);
  buckets.LATER.sort(compareByDue);
  buckets.NO_DUE.sort(compareByPriority);
  buckets.DONE.sort(compareByCompletedDesc);
  return TASK_GROUP_ORDER.filter(key => buckets[key].length > 0).map(key => ({
    key,
    label: TASK_GROUP_LABELS[key],
    items: buckets[key],
  }));
}
