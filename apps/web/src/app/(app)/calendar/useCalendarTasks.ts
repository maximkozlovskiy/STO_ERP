'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { onCalendarChanged } from '@/lib/calendar-events';
import { taskListPath, type PaginatedTasks } from '@/hooks/api/useTasks';
import type { CalView } from './calendar.types';
import { tasksByDay, tasksOfDay, type CalendarTask } from './calendar-tasks';

/** Найбільша сторінка `GET /tasks` — задач одного місяця в календарі більше не буває. */
const TASKS_PER_RANGE = 200;

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
  const [tasks, setTasks] = useState<CalendarTask[]>([]);
  const range = calendarTaskRange(view, date);
  const from = range?.from ?? '';
  const to = range?.to ?? '';
  // Номер останнього запиту: пізня відповідь попереднього дня не перезаписує новий.
  const reqRef = useRef(0);

  const load = useCallback(() => {
    const req = ++reqRef.current;
    if (!from || !to) {
      setTasks([]);
      return;
    }
    const path = taskListPath({
      page: 1,
      limit: TASKS_PER_RANGE,
      from,
      to,
      sortBy: 'startAt',
      sortDir: 'asc',
    });
    apiFetch<PaginatedTasks>(path).then(
      res => {
        if (req === reqRef.current) setTasks(res.items);
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
  const byDay = useMemo(() => (view === 'month' ? tasksByDay(tasks) : {}), [tasks, view]);

  return { tasks, dayTasks, byDay, reload: load };
}
