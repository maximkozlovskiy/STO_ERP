import { addDaysISO } from '@/lib/format';

export interface RevenueWeekDay {
  date: string;
  revenue: number;
  count: number;
}

/**
 * «Виручка за 7 днів» — усі сім київських днів до `today` включно, у порядку дат; день без виручки
 * — нулем (UX-огляд 2026-10-29: графік показував лише дні з виручкою, 4 стовпці замість 7).
 * Рядки поза тижнем відкидаються; повтори дня складаються.
 */
export function fillRevenueWeek(
  rows: readonly RevenueWeekDay[],
  today: string,
  days = 7,
): RevenueWeekDay[] {
  const byDate = new Map<string, RevenueWeekDay>();
  for (const r of rows) {
    const key = r.date.slice(0, 10);
    const prev = byDate.get(key);
    byDate.set(
      key,
      prev
        ? { date: key, revenue: prev.revenue + r.revenue, count: prev.count + r.count }
        : { date: key, revenue: r.revenue, count: r.count },
    );
  }
  return Array.from({ length: days }, (_, i) => {
    const date = addDaysISO(today, i - (days - 1));
    return byDate.get(date) ?? { date, revenue: 0, count: 0 };
  });
}
