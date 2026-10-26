'use client';

import { Suspense, useCallback, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  BarChart2,
  CalendarRange,
  ListPlus,
} from 'lucide-react';
import { isTaskManagerRole } from '@sto/shared';

import { useRequireAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { TaskPrefill } from '@/components/ui/TaskEditModal';

import {
  toDateString,
  formatKyivDate,
  fmtKyivMonthYear,
  canManageCalendarSlots,
  pad,
} from './calendar.utils';
import { CalendarMonthView } from './CalendarMonthView';
import { CalendarLegend } from './CalendarLegend';
import { CalendarCategoryCounters } from './CalendarCategoryCounters';
import { CalendarStatsTab } from './CalendarStatsTab';
import { CalendarSlotModal } from './CalendarSlotModal';
import { CalendarDayGrid } from './CalendarDayGrid';
import { useCalendarState, EMPTY_FORM } from './useCalendarState';
import { useCalendarTasks } from './useCalendarTasks';

// Картка задачі — окремим чанком: відкривається лише кліком по задачі чи «+ Задача».
const TaskEditModal = dynamic(
  () => import('@/components/ui/TaskEditModal').then(m => m.TaskEditModal),
  { ssr: false },
);
import type { CalendarTask } from './calendar-tasks';

// Module-level — stable tuple-array avoids re-creation on every CalendarPageClient
// render (and re-allocation of inner tuples). The icon refs are pure component
// constructors, safe to capture once.
const VIEW_SWITCHER: ReadonlyArray<
  readonly ['day' | 'month' | 'stats', string, typeof CalendarDays]
> = [
  ['day', 'views.day', CalendarDays],
  ['month', 'views.month', CalendarRange],
  ['stats', 'views.stats', BarChart2],
] as const;

function CalendarPageClient() {
  const { employee } = useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC']);
  const { t } = useTranslation('calendar');
  // Механік бачить календар, але створювати й змінювати записи API йому не дає (403) —
  // форма лише для перегляду, дій створення немає (Bug #871).
  const canManageSlots = canManageCalendarSlots(employee?.role);

  const cs = useCalendarState({ canManageSlots });
  // Задачі співробітникам — окремий тип (BR-TASK-007): свій запит на видимий день чи місяць.
  const canManageTasks = isTaskManagerRole(employee?.role);
  const ct = useCalendarTasks(cs.calView, cs.date);
  const [taskCard, setTaskCard] = useState<{ taskId: string | null; prefill?: TaskPrefill } | null>(
    null,
  );
  const openTask = useCallback((task: CalendarTask) => setTaskCard({ taskId: task.id }), []);
  // Нова задача на дату — термін на кінець робочого дня. Філія, що працює до 24:00, дала б
  // «T24:00» — такого часу у полі немає, тож кінець доби — 23:59.
  const newTaskOn = useCallback(
    (d: string) => {
      const end = cs.windowEnd >= 24 ? '23:59' : `${pad(cs.windowEnd)}:00`;
      setTaskCard({ taskId: null, prefill: { dueAt: `${d}T${end}` } });
    },
    [cs.windowEnd],
  );

  // sto-optimize: пара дублює `new Date(cs.nowMs)` + `toDateString()` двічі у render path
  // (один раз для className tinting, другий — для текст-suffix "минулий день").
  // Memoize → один Intl.format() виклик на render.
  const isPastDay = useMemo(
    () => !!cs.nowMs && cs.date < toDateString(new Date(cs.nowMs)),
    [cs.nowMs, cs.date],
  );

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <h1 className="page-title">{t('title')}</h1>
        <div className="flex items-center gap-3">
          {/* «?» пояснює іконки й кольори категорій і типів записів — у «День» і «Місяць»
              (BR-CAL-009; рішення власника 2026-10-15) */}
          {cs.calView !== 'stats' && <CalendarLegend />}
          {/* View switcher */}
          <div className="flex rounded-lg border border-border overflow-hidden text-sm">
            {VIEW_SWITCHER.map(([v, labelKey, Icon]) => (
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
                {t(labelKey)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Fixed: nav + form (shrink-0), then scrollable grid */}
      <div className="flex-1 min-h-0 flex flex-col">
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
                  {t('nav.prev')}
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
                  {t('nav.next')}
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => cs.setDate(toDateString(new Date()))}
                >
                  {t('nav.thisMonth')}
                </Button>
                {canManageTasks && (
                  <Button
                    variant="outline"
                    className="ml-auto"
                    onClick={() => newTaskOn(cs.date)}
                    data-testid="calendar-new-task"
                  >
                    <ListPlus className="h-4 w-4" aria-hidden="true" />
                    {t('tasks.new')}
                  </Button>
                )}
                {canManageSlots && (
                  <Button
                    className={canManageTasks ? '' : 'ml-auto'}
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
                    {t('nav.slot')}
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={cs.prevDay}>
                  <ChevronLeft className="h-4 w-4" />
                  {t('nav.prev')}
                </Button>
                <div className="flex items-center gap-2">
                  <DatePickerInput
                    value={cs.date}
                    onChange={cs.setDate}
                    placeholder={t('nav.datePlaceholder')}
                    className="w-48"
                  />
                  <span
                    className={`text-sm capitalize ${isPastDay ? 'text-destructive-text font-medium' : 'text-muted-foreground'}`}
                  >
                    {formatKyivDate(cs.date)}
                    {isPastDay ? t('nav.pastDaySuffix') : ''}
                  </span>
                </div>
                <Button variant="outline" size="sm" onClick={cs.nextDay}>
                  {t('nav.next')}
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => cs.setDate(toDateString(new Date()))}
                >
                  {t('nav.today')}
                </Button>
                {/* Підсумок дня за категоріями — той самий рядок, що в клітинці місяця
                    (BR-CAL-008), з денних записів. */}
                <CalendarCategoryCounters
                  entries={cs.dayEntries}
                  nowMs={cs.nowMs}
                  testId="day-categories"
                  size="md"
                />
                {canManageTasks && (
                  <Button
                    variant="outline"
                    className="ml-auto"
                    onClick={() => newTaskOn(cs.date)}
                    data-testid="calendar-new-task"
                  >
                    <ListPlus className="h-4 w-4" aria-hidden="true" />
                    {t('tasks.new')}
                  </Button>
                )}
                {canManageSlots && (
                  <Button
                    className={canManageTasks ? '' : 'ml-auto'}
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
                    {t('nav.slot')}
                  </Button>
                )}
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
          onWorkOrderChanged={cs.refreshView}
          date={cs.date}
          lifts={cs.lifts}
          form={cs.form}
          setForm={cs.setForm}
          editingSlotId={cs.editingSlotId}
          isEditingPast={cs.isEditingPast}
          readOnly={!canManageSlots}
          savedMechanic={cs.savedMechanic}
          editingWorkOrder={cs.editingWorkOrder}
          pendingSlot={cs.pendingSlot}
          setPendingSlot={cs.setPendingSlot}
          formMounted={cs.formMounted}
          formVisible={cs.formVisible}
          formCollapseRef={cs.formCollapseRef}
          formInnerRef={cs.formInnerRef}
          minHour={cs.minHour}
          windowStart={cs.windowStart}
          windowEnd={cs.windowEnd}
          nowMs={cs.nowMs}
          error={cs.error}
          setError={cs.setError}
          saving={cs.saving}
          setSaving={cs.setSaving}
          cpDisplay={cs.cpDisplay}
          setCpDisplay={cs.setCpDisplay}
        />

        {/* ── View routing — scrollable ────────────────────────────────────── */}
        {/* day view scrolls internally inside CalendarDayGrid; month/stats scroll here */}
        <div
          className={`flex-1 min-h-0 ${cs.calView === 'day' ? 'overflow-y-hidden flex flex-col' : 'overflow-y-auto'}`}
        >
          {cs.calView === 'month' && (
            <CalendarMonthView
              yearMonth={cs.yearMonth}
              monthSlots={cs.monthSlots}
              monthLoading={cs.monthLoading}
              monthError={cs.monthError}
              nowMs={cs.nowMs}
              onDayClick={cs.openDay}
              onOpenSlot={cs.openMonthSlot}
              onNewOnDate={canManageSlots ? cs.openNewOnDate : undefined}
              tasksByDay={ct.byDay}
              onOpenTask={openTask}
              onNewTaskOnDate={canManageTasks ? newTaskOn : undefined}
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
              windowStart={cs.windowStart}
              windowEnd={cs.windowEnd}
            />
          )}

          {cs.calView === 'day' && (
            <CalendarDayGrid state={cs} tasks={ct.dayTasks} onOpenTask={openTask} />
          )}

          <ConfirmDialog {...cs.dialogProps} />
          <TaskEditModal
            open={!!taskCard}
            taskId={taskCard?.taskId ?? null}
            prefill={taskCard?.prefill}
            onClose={() => setTaskCard(null)}
          />
        </div>
        {/* end scrollable grid */}
      </div>
      {/* end content col */}
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
