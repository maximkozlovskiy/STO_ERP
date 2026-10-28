'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { onCalendarChanged } from '@/lib/calendar-events';
import { taskListPath, type PaginatedTasks } from '@/hooks/api/useTasks';
import type { CalView } from './calendar.types';
import { tasksByDay, tasksOfDay, type CalendarTask } from './calendar-tasks';

const NO_TASKS: CalendarTask[] = [];

/** Найбільша сторінка `GET /tasks` (`@Max(200)` у DTO). */
const TASKS_PER_PAGE = 200;
/** Запобіжник: більше сторінок за один період не читаємо (25 × 200 = 5000 задач). */
export const TASKS_MAX_PAGES = 25;

/**
 * Усі задачі періоду: перша сторінка, далі — решта паралельно за `total`. Раніше календар брав
 * лише першу сотню-дві, і задачі понад неї в місяці мовчки зникали з календаря.
 */
export async function loadAllTaskPages<T>(
  fetchPage: (page: number) => Promise<{ items: T[]; total: number }>,
): Promise<T[]> {
  const first = await fetchPage(1);
  const pages = Math.min(Math.ceil(first.total / TASKS_PER_PAGE), TASKS_MAX_PAGES);
  if (pages <= 1) return first.items;
  const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => fetchPage(i + 2)));
  return [first, ...rest].flatMap(r => r.items);
}

/** Межі видимого періоду: день — одна доба, місяць — від 1-го до останнього числа. */
export function calendarTaskRange(
  view: CalView,
  date: string,
): { from: string; to: string } | null {
  if (!date) return null;
  if (view === 'day') return { from: date, to: date };
  if (view !== 'month') return null;
  const [y, m] = date.split('-').map(Number);
  if (!y || !m) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

/**
 * Задачі видимого періоду календаря — ОДИН запит `GET /tasks?from&to` на день чи на місяць
 * (BR-TASK-004), окремо від записів календаря (задачі не займають час, BR-TASK-007). Механік
 * отримує лише свої задачі — це вирішує сервер (BR-TASK-002). Перечитуються, коли календар
 * отримує подію змін (`notifyCalendarChanged` — після будь-якої дії із задачею).
 */
export function useCalendarTasks(view: CalView, date: string) {
  const range = calendarTaskRange(view, date);
  const from = range?.from ?? '';
  const to = range?.to ?? '';
  // Задачі разом із періодом, для якого їх завантажено: до відповіді нового періоду віддаємо
  // порожньо, а не задачі попереднього — підсумки «Місяця» рахують увесь масив (Bug #988).
  const periodKey = `${from}|${to}`;
  const [loaded, setLoaded] = useState<{ key: string; items: CalendarTask[] }>({
    key: '',
    items: [],
  });
  const tasks = loaded.key === periodKey ? loaded.items : NO_TASKS;
  // Номер останнього запиту: пізня відповідь попереднього дня не перезаписує новий.
  const reqRef = useRef(0);

  const load = useCallback(() => {
    const req = ++reqRef.current;
    const key = `${from}|${to}`;
    const setTasks = (items: CalendarTask[]) => setLoaded({ key, items });
    if (!from || !to) {
      setTasks([]);
      return;
    }
    const fetchPage = (page: number) =>
      apiFetch<PaginatedTasks>(
        taskListPath({ page, limit: TASKS_PER_PAGE, from, to, sortBy: 'startAt', sortDir: 'asc' }),
      );
    loadAllTaskPages(fetchPage).then(
      items => {
        if (req === reqRef.current) setTasks(items);
      },
      () => {
        // Збій задач не ламає календар записів — смуга просто порожня.
        if (req === reqRef.current) setTasks([]);
      },
    );
  }, [from, to]);

  useEffect(() => {
    load();
    return () => {
      // Відповідь після розмонтування чи зміни періоду ігнорується.
      reqRef.current += 1;
    };
  }, [load]);

  useEffect(() => onCalendarChanged(load), [load]);

  const dayTasks = useMemo(
    () => (view === 'day' && date ? tasksOfDay(tasks, date) : []),
    [tasks, view, date],
  );
  // Дні — у межах видимого місяця: довга задача, що почалась раніше, лягає на його дні.
  const byDay = useMemo(
    () => (view === 'month' && from && to ? tasksByDay(tasks, { from, to }) : {}),
    [tasks, view, from, to],
  );

  return { tasks, dayTasks, byDay, reload: load };
}
