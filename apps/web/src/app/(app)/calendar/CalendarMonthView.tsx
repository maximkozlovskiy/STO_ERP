'use client';

import { useTranslation } from 'react-i18next';
import { Spinner } from '@/components/ui/spinner';
import type { MonthSlots } from './calendar.types';
import { toDateString } from './calendar.utils';

interface CalendarMonthViewProps {
  yearMonth: string; // 'YYYY-MM'
  monthSlots: MonthSlots;
  monthLoading: boolean;
  monthError: boolean;
  nowMs: number;
  onDayClick: (dateStr: string) => void;
}

const DAY_LABEL_KEYS = [
  'month.weekdays.mon',
  'month.weekdays.tue',
  'month.weekdays.wed',
  'month.weekdays.thu',
  'month.weekdays.fri',
  'month.weekdays.sat',
  'month.weekdays.sun',
] as const;

export function CalendarMonthView({
  yearMonth,
  monthSlots,
  monthLoading,
  monthError,
  nowMs,
  onDayClick,
}: CalendarMonthViewProps) {
  const { t } = useTranslation('calendar');
  const [y, m] = yearMonth ? yearMonth.split('-').map(Number) : [0, 0];
  if (!y || !m) return null;

  const firstDay = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const todayStr = nowMs ? toDateString(new Date(nowMs)) : '';

  // Monday-first: 0=Mon … 6=Sun
  const startOffset = (firstDay.getDay() + 6) % 7;
  const cells: (string | null)[] = [
    ...Array<null>(startOffset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => {
      const d = i + 1;
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }),
  ];
  // Pad to full weeks
  while (cells.length % 7 !== 0) cells.push(null);

  const maxSlots = Math.max(1, ...Object.values(monthSlots).map(v => v.total));

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      {monthLoading && (
        <div className="flex justify-center py-12">
          <Spinner size="md" />
        </div>
      )}
      {!monthLoading && monthError && (
        <div className="px-4 py-8 text-center text-sm text-destructive-text">
          {t('month.loadError')}
        </div>
      )}
      {!monthLoading && !monthError && (
        <>
          {/* Day-of-week header */}
          <div className="grid grid-cols-7 border-b border-border">
            {DAY_LABEL_KEYS.map(dk => (
              <div
                key={dk}
                className="py-2 text-center text-xs font-medium text-muted-foreground bg-secondary"
              >
                {t(dk)}
              </div>
            ))}
          </div>
          {/* Weeks */}
          {Array.from({ length: cells.length / 7 }, (_, wi) => (
            <div key={wi} className="grid grid-cols-7 border-b border-border last:border-b-0">
              {cells.slice(wi * 7, wi * 7 + 7).map((dayStr, di) => {
                if (!dayStr)
                  return (
                    <div
                      key={di}
                      className="min-h-20 bg-secondary/40 border-r border-border last:border-r-0"
                    />
                  );
                const info = monthSlots[dayStr];
                const total = info?.total ?? 0;
                const isToday = dayStr === todayStr;
                const isPast = nowMs ? dayStr < todayStr : false;
                const load = total / maxSlots;
                const bgAlpha = total === 0 ? 0 : Math.max(0.08, load * 0.5);
                const dayNum = parseInt(dayStr.slice(8), 10);
                return (
                  <button
                    key={dayStr}
                    type="button"
                    onClick={() => onDayClick(dayStr)}
                    className={`min-h-20 border-r border-border last:border-r-0 p-2 text-left transition-colors hover:bg-primary/5 flex flex-col gap-1 ${isPast ? 'opacity-60' : ''}`}
                    style={
                      total > 0
                        ? {
                            backgroundColor: `color-mix(in srgb, var(--color-primary) ${Math.round(bgAlpha * 100)}%, transparent)`,
                          }
                        : undefined
                    }
                  >
                    <span
                      className={`text-sm font-semibold leading-none ${isToday ? 'flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs' : 'text-foreground'}`}
                    >
                      {dayNum}
                    </span>
                    {total > 0 && (
                      <span className="text-[11px] text-primary font-medium leading-none">
                        {t(
                          total === 1
                            ? 'month.recordsOne'
                            : total < 5
                              ? 'month.recordsFew'
                              : 'month.recordsMany',
                          { count: total },
                        )}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
