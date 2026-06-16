'use client';

import { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import type { CalendarSlot, Lift, StatsPeriod } from './calendar.types';
import { toDateString, STATS_MAX_DAYS, fmtKyivMonthYear } from './calendar.utils';
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
  windowStart: number;
  windowEnd: number;
}

// Static period switcher tuples — module-level, не пересоздається на кожен render.
const PERIOD_OPTIONS: ReadonlyArray<readonly [StatsPeriod, string]> = [
  ['day', 'День'],
  ['month', 'Місяць'],
  ['custom', 'Довільний'],
] as const;

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
  windowStart,
  windowEnd,
}: CalendarStatsTabProps) {
  const WINDOW_H = windowEnd - windowStart;

  // sto-optimize: всі derived metrics через useMemo щоб typing у parent date-inputs
  // не тригерив повний recompute (3 derived passes по statsSlots/lifts кожен render).
  // Clamp to STATS_MAX_DAYS so the load% denominator matches the actually loaded slot set.
  const days = useMemo(() => {
    if (!statsRange) return 1;
    let count = 0;
    const cur = new Date(statsRange.from + 'T12:00:00');
    const end = new Date(statsRange.to + 'T12:00:00');
    while (cur <= end && count < STATS_MAX_DAYS) {
      count++;
      cur.setDate(cur.getDate() + 1);
    }
    return count;
  }, [statsRange]);

  // sto-optimize: bucket statsSlots by liftId один раз + pre-parse Date→Ms у числа
  // → O(N+M) замість O(N×M) `filter+reduce(new Date()×2)` per lift. На 30 днів × 5
  // ліфтів × 100 slots було 30_000 Date allocs; стає 60. Single-pass також рахує
  // totalMinAll + avgLoadPct (для summary cards) щоб уникнути окремих reduce у JSX.
  const { liftStats, totalMinAll, avgLoadPct } = useMemo(() => {
    const byLift = new Map<string, { count: number; totalMinutes: number }>();
    for (const s of statsSlots) {
      if (!s.liftId) continue;
      const minutes = (new Date(s.endAt).getTime() - new Date(s.startAt).getTime()) / 60000;
      const acc = byLift.get(s.liftId);
      if (acc) {
        acc.count++;
        acc.totalMinutes += minutes;
      } else {
        byLift.set(s.liftId, { count: 1, totalMinutes: minutes });
      }
    }
    const denom = WINDOW_H * days;
    let totalAll = 0;
    let sumLoad = 0;
    const stats = lifts.map(lift => {
      const agg = byLift.get(lift.id);
      const count = agg?.count ?? 0;
      const totalMinutes = agg?.totalMinutes ?? 0;
      const loadPct = denom > 0 ? Math.round((totalMinutes / 60 / denom) * 100) : 0;
      totalAll += totalMinutes;
      sumLoad += loadPct;
      return { lift, count, totalMinutes, loadPct };
    });
    return {
      liftStats: stats,
      totalMinAll: totalAll,
      avgLoadPct: stats.length ? Math.round(sumLoad / stats.length) : null,
    };
  }, [statsSlots, lifts, WINDOW_H, days]);

  const periodLabel = useMemo(() => {
    if (!statsRange) return '—';
    if (statsRange.from === statsRange.to) return formatKyivDate(statsRange.from);
    return `${statsRange.from.split('-').reverse().join('.')} — ${statsRange.to.split('-').reverse().join('.')}`;
  }, [statsRange]);

  return (
    <div className="space-y-4">
      {/* Period selector */}
      <div className="bg-surface border border-border rounded-xl p-4 flex flex-wrap items-end gap-4">
        {/* Pill switcher */}
        <div>
          <p className="text-xs text-muted-foreground mb-1.5">Період</p>
          <div className="flex rounded-lg border border-border overflow-hidden text-sm">
            {PERIOD_OPTIONS.map(([v, label]) => (
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
                  {fmtKyivMonthYear(date)}
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
            value: avgLoadPct !== null ? `${avgLoadPct}%` : '—',
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
