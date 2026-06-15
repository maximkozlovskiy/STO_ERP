'use client';

import { Suspense } from 'react';
import {
  Plus,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  BarChart2,
  CalendarRange,
} from 'lucide-react';

import { useRequireAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

import { toDateString, formatKyivDate, fmtKyivMonthYear } from './calendar.utils';
import { CalendarMonthView } from './CalendarMonthView';
import { CalendarStatsTab } from './CalendarStatsTab';
import { CalendarSlotModal } from './CalendarSlotModal';
import { CalendarDayGrid } from './CalendarDayGrid';
import { useCalendarState, EMPTY_FORM } from './useCalendarState';

// Module-level — stable tuple-array avoids re-creation on every CalendarPageClient
// render (and re-allocation of inner tuples). The icon refs are pure component
// constructors, safe to capture once.
const VIEW_SWITCHER: ReadonlyArray<
  readonly ['day' | 'month' | 'stats', string, typeof CalendarDays]
> = [
  ['day', 'День', CalendarDays],
  ['month', 'Місяць', CalendarRange],
  ['stats', 'Статистика', BarChart2],
] as const;

function CalendarPageClient() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC']);

  const cs = useCalendarState();

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <h1 className="page-title">Календар</h1>
        <div className="flex items-center gap-2">
          {/* View switcher */}
          <div className="flex rounded-lg border border-border overflow-hidden text-sm">
            {VIEW_SWITCHER.map(([v, label, Icon]) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  cs.setCalView(v);
                  if (v === 'stats') {
                    cs.setShowAdd(false);
                    cs.setEditingSlotId(null);
                  }
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${cs.calView === v ? 'bg-primary text-primary-foreground' : 'bg-surface text-muted-foreground hover:bg-secondary'}`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Scrollable content area */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Date / month navigation — hidden in stats view */}
        {cs.calView !== 'stats' && (
          <div className="flex items-center gap-4 mb-3">
            {cs.calView === 'month' ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const [y, m] = cs.yearMonth.split('-').map(Number);
                    const d = new Date(y, m - 2, 1);
                    cs.setDate(
                      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`,
                    );
                  }}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Попередній
                </Button>
                <span className="text-sm font-medium text-foreground capitalize">
                  {cs.date ? fmtKyivMonthYear(cs.date) : ''}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const [y, m] = cs.yearMonth.split('-').map(Number);
                    const d = new Date(y, m, 1);
                    cs.setDate(
                      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`,
                    );
                  }}
                >
                  Наступний
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => cs.setDate(toDateString(new Date()))}
                >
                  Цей місяць
                </Button>
                <Button
                  className="ml-auto"
                  onClick={() => {
                    cs.setPendingSlot(null);
                    cs.setEditingSlotId(null);
                    cs.setError('');
                    cs.setCpDisplay('');
                    cs.setForm(EMPTY_FORM);
                    cs.setShowAdd(v => !v);
                  }}
                >
                  <Plus className="h-4 w-4" />
                  Слот
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={cs.prevDay}>
                  <ChevronLeft className="h-4 w-4" />
                  Попередній
                </Button>
                <div className="flex items-center gap-2">
                  <DatePickerInput
                    value={cs.date}
                    onChange={cs.setDate}
                    placeholder="Дата"
                    className="w-48"
                  />
                  <span
                    className={`text-sm capitalize ${cs.nowMs && cs.date < toDateString(new Date(cs.nowMs)) ? 'text-destructive-text font-medium' : 'text-muted-foreground'}`}
                  >
                    {formatKyivDate(cs.date)}
                    {cs.nowMs && cs.date < toDateString(new Date(cs.nowMs))
                      ? ' — минулий день'
                      : ''}
                  </span>
                </div>
                <Button variant="outline" size="sm" onClick={cs.nextDay}>
                  Наступний
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => cs.setDate(toDateString(new Date()))}
                >
                  Сьогодні
                </Button>
                <Button
                  className="ml-auto"
                  onClick={() => {
                    cs.setPendingSlot(null);
                    cs.setEditingSlotId(null);
                    cs.setError('');
                    cs.setCpDisplay('');
                    cs.setForm(EMPTY_FORM);
                    cs.setShowAdd(v => !v);
                  }}
                >
                  <Plus className="h-4 w-4" />
                  Слот
                </Button>
              </>
            )}
          </div>
        )}

        {/* ── Add / edit form modal — hidden in stats view ─────────────────── */}
        <CalendarSlotModal
          open={cs.showAdd && cs.calView !== 'stats'}
          onClose={cs.handleModalClose}
          onSaved={cs.handleModalSaved}
          onDeleted={cs.handleModalSaved}
          date={cs.date}
          lifts={cs.lifts}
          form={cs.form}
          setForm={cs.setForm}
          editingSlotId={cs.editingSlotId}
          isEditingPast={cs.isEditingPast}
          pendingSlot={cs.pendingSlot}
          setPendingSlot={cs.setPendingSlot}
          formMounted={cs.formMounted}
          formVisible={cs.formVisible}
          formCollapseRef={cs.formCollapseRef}
          formInnerRef={cs.formInnerRef}
          minHour={cs.minHour}
          nowMs={cs.nowMs}
          error={cs.error}
          setError={cs.setError}
          saving={cs.saving}
          setSaving={cs.setSaving}
          cpDisplay={cs.cpDisplay}
          setCpDisplay={cs.setCpDisplay}
        />

        {/* ── View routing ─────────────────────────────────────────────────── */}
        {cs.calView === 'month' && (
          <CalendarMonthView
            yearMonth={cs.yearMonth}
            monthSlots={cs.monthSlots}
            monthLoading={cs.monthLoading}
            monthError={cs.monthError}
            nowMs={cs.nowMs}
            onDayClick={dayStr => {
              cs.setDate(dayStr);
              cs.setCalView('day');
            }}
          />
        )}

        {cs.calView === 'stats' && (
          <CalendarStatsTab
            lifts={cs.lifts}
            statsSlots={cs.statsSlots}
            statsLoading={cs.statsLoading}
            statsError={cs.statsError}
            statsPeriod={cs.statsPeriod}
            setStatsPeriod={cs.setStatsPeriod}
            statsFrom={cs.statsFrom}
            setStatsFrom={cs.setStatsFrom}
            statsTo={cs.statsTo}
            setStatsTo={cs.setStatsTo}
            statsRangeTooLong={cs.statsRangeTooLong}
            date={cs.date}
            setDate={cs.setDate}
            statsRange={cs.statsRange}
          />
        )}

        {cs.calView === 'day' && <CalendarDayGrid state={cs} />}

        <ConfirmDialog {...cs.dialogProps} />
      </div>
      {/* end scrollable content */}
    </div>
  );
}

export default function CalendarPage() {
  return (
    <Suspense fallback={null}>
      <CalendarPageClient />
    </Suspense>
  );
}
