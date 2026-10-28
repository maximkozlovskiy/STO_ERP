'use client';

import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { onCalendarChanged } from '@/lib/calendar-events';
import { infraKeys } from '@/hooks/api/useInfrastructure';
import { useBranchWorkHours } from '@/hooks/useBranchWorkHours';
import type { CalendarSlot, Lift } from './calendar.types';
import { buildMonthSlots, liveSlots, slotsByKyivDay } from './calendar-month';
import { useCalendarTasks } from './useCalendarTasks';

export const monthSummaryKeys = {
  slots: (yearMonth: string) => ['calendar', 'month-summary', yearMonth] as const,
};

/** Дні місяця `YYYY-MM` і перше число наступного (кінець ланцюжка, BR-CAL-008). */
function monthDays(yearMonth: string): { days: string[]; next: string } {
  const [y, m] = yearMonth.split('-').map(Number);
  if (!y || !m) return { days: [], next: '' };
  const n = new Date(y, m, 0).getDate();
  const days = Array.from(
    { length: n },
    (_, i) => `${yearMonth}-${String(i + 1).padStart(2, '0')}`,
  );
  const nm = new Date(y, m, 1);
  const next = `${nm.getFullYear()}-${String(nm.getMonth() + 1).padStart(2, '0')}-01`;
  return { days, next };
}

/**
 * Дані підсумків місяця календаря (BR-CAL-013) поза календарем — для дашборда: записи місяця
 * одним запитом діапазону (як «Місяць»), підйомники, задачі місяця й робочі години головної філії.
 * Записи перечитуються, коли календар повідомляє про зміни (`notifyCalendarChanged`).
 */
export function useMonthSummaryData(yearMonth: string, enabled: boolean) {
  const qc = useQueryClient();
  const { days, next } = useMemo(() => monthDays(yearMonth), [yearMonth]);

  const slotsQuery = useQuery({
    queryKey: monthSummaryKeys.slots(yearMonth),
    queryFn: ({ signal }) =>
      apiFetch<CalendarSlot[]>(`/calendar/slots?from=${days[0]}&to=${next}`, { signal }),
    enabled: enabled && days.length > 0,
    staleTime: 60_000,
  });
  useEffect(
    () =>
      onCalendarChanged(() => {
        void qc.invalidateQueries({ queryKey: monthSummaryKeys.slots(yearMonth) });
      }),
    [qc, yearMonth],
  );

  const monthSlots = useMemo(
    () =>
      slotsQuery.data
        ? buildMonthSlots(slotsByKyivDay(liveSlots(slotsQuery.data), [...days, next]), days)
        : {},
    [slotsQuery.data, days, next],
  );
  // Не `useLifts()`: той вмикається для будь-якої ролі, а дашборд ролі без календаря не має
  // слати запитів, які їй не віддадуть (Bug #879). Ключ кешу той самий.
  const { data: lifts } = useQuery({
    queryKey: infraKeys.lifts,
    queryFn: ({ signal }) => apiFetch<Lift[]>('/lifts', { signal }),
    enabled,
    staleTime: 5 * 60_000,
  });
  const { tasks } = useCalendarTasks(enabled ? 'month' : 'day', enabled ? `${yearMonth}-01` : '');
  const { startHour, endHour } = useBranchWorkHours(null, { mainBranch: true });
  // «Прострочено» й завантаження рахуються на момент відкриття — дашборд і так оновлюється живо.
  const nowMs = useMemo(
    () => (slotsQuery.dataUpdatedAt ? Date.now() : 0),
    [slotsQuery.dataUpdatedAt],
  );

  return {
    monthSlots,
    lifts: lifts ?? [],
    tasks,
    windowStart: startHour,
    windowEnd: endHour,
    nowMs,
    loading: slotsQuery.isLoading,
    error: slotsQuery.isError,
  };
}
