'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import type { CalendarSlot, Lift, StatsPeriod } from './calendar.types';
import { KYIV_TZ, toDateString, STATS_MAX_DAYS, WINDOW_END, WINDOW_START } from './calendar.utils';
import { formatKyivDate } from './calendar.utils';

interface CalendarStatsTabProps {
  lifts: Lift[];
  statsSlots: CalendarSlot[];
  statsLoading: boolean;
  statsError: boolean;
  statsPeriod: StatsPeriod;
  setStatsPeriod: (p: StatsPeriod) => void;
  statsFrom: string;
  setStatsFrom: (v: string) => void;
  statsTo: string;
  setStatsTo: (v: string) => void;
  statsRangeTooLong: boolean;
  /** Current selected date (used for day/month period context) */
  date: string;
  setDate: (d: string) => void;
  statsRange: { from: string; to: string } | null;
}

const WINDOW_H = WINDOW_END - WINDOW_START; // 11 h

export function CalendarStatsTab({
  lifts,
  statsSlots,
  statsLoading,
  statsError,
  statsPeriod,
  setStatsPeriod,
  statsFrom,
  setStatsFrom,
  statsTo,
  setStatsTo,
  statsRangeTooLong,
  date,
  setDate,
  statsRange,
}: CalendarStatsTabProps) {
  // Clamp to STATS_MAX_DAYS so the load% denominator matches the actually loaded slot set
  const days = statsRange
    ? (() => {
        const d: string[] = [];
        const cur = new Date(statsRange.from + 'T12:00:00');
        const end = new Date(statsRange.to + 'T12:00:00');
        while (cur <= end && d.length < STATS_MAX_DAYS) {
          d.push(toDateString(cur));
          cur.setDate(cur.getDate() + 1);
        }
        return d.length;
      })()
    : 1;

  const liftStats = lifts.map(lift => {
    const ls = statsSlots.filter(s => s.liftId === lift.id);
    const totalMinutes = ls.reduce(
      (acc, s) => acc + (new Date(s.endAt).getTime() - new Date(s.startAt).getTime()) / 60000,
      0,
    );
    const loadPct = days > 0 ? Math.round((totalMinutes / 60 / (WINDOW_H * days)) * 100) : 0;
    return { lift, count: ls.length, totalMinutes, loadPct };
  });
  const totalMinAll = liftStats.reduce((a, x) => a + x.totalMinutes, 0);

  const periodLabel = statsRange
    ? statsRange.from === statsRange.to
      ? formatKyivDate(statsRange.from)
      : `${statsRange.from.split('-').reverse().join('.')} — ${statsRange.to.split('-').reverse().join('.')}`
    : '—';

  return (
    <div className="space-y-4">
      {/* Period selector */}
      <div className="bg-surface border border-border rounded-xl p-4 flex flex-wrap items-end gap-4">
        {/* Pill switcher */}
        <div>
          <p className="text-xs text-muted-foreground mb-1.5">Період</p>
          <div className="flex rounded-lg border border-border overflow-hidden text-sm">
            {(
              [
                ['day', 'День'],
                ['month', 'Місяць'],
                ['custom', 'Довільний'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setStatsPeriod(v)}
                className={`px-3 py-1.5 transition-colors ${statsPeriod === v ? 'bg-primary text-primary-foreground' : 'bg-surface text-muted-foreground hover:bg-secondary'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Day: date picker */}
        {statsPeriod === 'day' && (
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">День</p>
            <DatePickerInput value={date} onChange={setDate} className="w-40" />
          </div>
        )}

        {/* Month: month+year picker */}
        {statsPeriod === 'month' && (
          <div className="flex items-center gap-2">
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">Місяць</p>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const [y, m] = date.split('-').map(Number);
                    const d = new Date(y, m - 2, 1);
                    setDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`);
                  }}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <span className="text-sm font-medium px-2 capitalize min-w-32 text-center">
                  {new Date(date + 'T12:00:00').toLocaleDateString('uk-UA', {
                    month: 'long',
                    year: 'numeric',
                    timeZone: KYIV_TZ,
                  })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const [y, m] = date.split('-').map(Number);
                    const d = new Date(y, m, 1);
                    setDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`);
                  }}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Custom: from–to date pickers */}
        {statsPeriod === 'custom' && (
          <>
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">Від</p>
              <DatePickerInput
                value={statsFrom}
                onChange={v => {
                  setStatsFrom(v);
                  if (!statsTo) setStatsTo(v);
                }}
                className="w-36"
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">До</p>
              <DatePickerInput value={statsTo} onChange={setStatsTo} className="w-36" />
            </div>
          </>
        )}

        {statsLoading && <Spinner size="sm" />}
      </div>

      {/* Validation hints */}
      {statsPeriod === 'custom' && statsFrom && statsTo && statsFrom > statsTo && (
        <p className="text-xs text-destructive-text">Дата «Від» повинна бути не пізніше за «До».</p>
      )}
      {statsRangeTooLong && (
        <p className="text-xs text-warning-text">
          Діапазон задовгий — показано перші {STATS_MAX_DAYS} днів. Звузьте період для повної
          статистики.
        </p>
      )}
      {statsError && (
        <p className="text-xs text-destructive-text">
          Не вдалося завантажити статистику. Перевірте з&#39;єднання та спробуйте ще раз.
        </p>
      )}

      {/* Period label */}
      <p className="text-xs text-muted-foreground">
        {statsRange
          ? `${days} ${days === 1 ? 'день' : days < 5 ? 'дні' : 'днів'} · ${periodLabel}`
          : 'Оберіть діапазон'}
      </p>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Всього записів', value: String(statsSlots.length) },
          {
            label: 'Загальний час',
            value: `${Math.floor(totalMinAll / 60)}г ${Math.round(totalMinAll % 60)}хв`,
          },
          {
            label: 'Середнє завант.',
            value: liftStats.length
              ? `${Math.round(liftStats.reduce((a, x) => a + x.loadPct, 0) / liftStats.length)}%`
              : '—',
          },
        ].map(({ label, value }) => (
          <div key={label} className="bg-surface border border-border rounded-xl p-4">
            <div className="text-xs text-muted-foreground mb-1">{label}</div>
            <div className="text-2xl font-bold text-foreground">{value}</div>
          </div>
        ))}
      </div>

      {/* Per-lift table */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary">
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                Пост
              </th>
              <th className="text-center px-4 py-2.5 text-xs font-medium text-muted-foreground">
                Записів
              </th>
              <th className="text-center px-4 py-2.5 text-xs font-medium text-muted-foreground">
                Час
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                Завантаженість {days > 1 ? `(за ${days} д.)` : '(11 год)'}
              </th>
            </tr>
          </thead>
          <tbody>
            {liftStats.map(({ lift, count, totalMinutes, loadPct }) => (
              <tr
                key={lift.id}
                className="border-b border-border last:border-b-0 hover:bg-secondary/50"
              >
                <td className="px-4 py-3 font-medium text-foreground">{lift.name}</td>
                <td className="px-4 py-3 text-center text-muted-foreground">{count}</td>
                <td className="px-4 py-3 text-center text-muted-foreground">
                  {Math.floor(totalMinutes / 60)}г {Math.round(totalMinutes % 60)}хв
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min(100, loadPct)}%`,
                          backgroundColor:
                            loadPct >= 80
                              ? 'var(--color-destructive)'
                              : loadPct >= 50
                                ? '#f59e0b'
                                : 'var(--color-primary)',
                        }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground w-9 text-right">{loadPct}%</span>
                  </div>
                </td>
              </tr>
            ))}
            {liftStats.length === 0 && !statsLoading && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground text-sm">
                  {statsRange ? 'Записів за цей період немає' : 'Оберіть діапазон дат'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
