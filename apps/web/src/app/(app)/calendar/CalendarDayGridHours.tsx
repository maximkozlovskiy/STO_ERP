'use client';

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DndContext } from '@dnd-kit/core';

import type { Lift } from './calendar.types';
import { pad } from './calendar.utils';
import { type CalendarState } from './useCalendarState';
import { CalendarTaskStrip } from './CalendarTaskStrip';
import { UnassignedSlots } from './CalendarDayBlocks';
import { DayGridStatus, LiftInfo, LiftLane, useLiftLanes } from './CalendarDayLane';
import { taskDayBlock, type CalendarTask } from './calendar-tasks';

/**
 * Найменша висота години в повернутій сітці, px: 15 хв — 14 px, блок у 30 хв ще читається.
 * Вільну висоту екрана години ділять між собою (рядок тіла — `minmax(…, 1fr)`).
 */
const HOUR_PX = 56;
/** Колонка підписів годин, px. */
const TIME_COL_PX = 64;

// ─── CalendarDayGridHours ────────────────────────────────────────────────────

interface Props {
  state: CalendarState;
  tasks?: readonly CalendarTask[];
  onOpenTask?: (task: CalendarTask) => void;
}

const NO_TASKS: readonly CalendarTask[] = [];
const noop = () => {};

/**
 * Вид «День», режим «Години × підйомники» (BR-CAL-014): рядки — години, колонки — підйомники,
 * ліворуч — колонка «Задачі». Ті самі записи, малювання, перетягування й зміна меж, що в
 * планувальнику (вісь часу — вертикальна, `useCalendarState` рахує її від `hoursTrackRef`);
 * перетягування вбік — на інший підйомник.
 */
/**
 * Вид «День», режим «Години × підйомники» (BR-CAL-014): рядки — години, колонки — підйомники,
 * ліворуч — колонка «Задачі». Ті самі записи, малювання, перетягування й зміна меж, що в
 * планувальнику (вісь часу — вертикальна, `useCalendarState` рахує її від `hoursTrackRef`);
 * перетягування вбік — на інший підйомник.
 */
export function CalendarDayGridHours({ state, tasks = NO_TASKS, onOpenTask = noop }: Props) {
  const { t } = useTranslation('calendar');
  const { loadByLift, laneData } = useLiftLanes(state);
  const { lifts, hours, totalHours, date, windowStart, windowEnd, hoursTrackRef } = state;

  // Колонка «Задачі» — лише коли хоч одна задача лягає на шкалу годин: інакше смуга порожня
  // (`CalendarTaskStrip` повертає null), а шапка «Задачі» стояла б над пустою колонкою.
  const hasTasks = useMemo(
    () => tasks.some(task => taskDayBlock(task, date, windowStart, windowEnd) !== null),
    [tasks, date, windowStart, windowEnd],
  );
  const columns = `${TIME_COL_PX}px ${hasTasks ? 'auto ' : ''}repeat(${lifts.length}, minmax(9rem, 1fr))`;
  const bodyHeight = totalHours * HOUR_PX;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <DayGridStatus state={state} hintKey="day.hintDrawHours" />

      {!state.loading && lifts.length > 0 && (
        <DndContext
          sensors={state.sensors}
          onDragEnd={e => {
            void state.handleDragEnd(e);
          }}
        >
          <div
            ref={state.timelineRef}
            className="bg-surface border border-border rounded-xl flex-1 min-h-0 overflow-auto"
            data-testid="day-grid-hours"
          >
            {/* Рядок тіла — не нижче HOUR_PX на годину, а вільну висоту екрана ділять години */}
            <div
              className="grid min-w-max min-h-full"
              style={{
                gridTemplateColumns: columns,
                gridTemplateRows: `auto minmax(${bodyHeight}px, 1fr)`,
              }}
            >
              {/* Шапка — липка у прокрутці; та сама сітка колонок, що й тіло */}
              {/* Кут: липкий і вгору, і вліво — над шапкою підйомників і колонкою годин */}
              <div className="sticky top-0 left-0 z-30 px-2 py-2 text-xs font-medium text-muted-foreground bg-secondary border-b border-r border-border">
                {t('day.colTime')}
              </div>
              {hasTasks && (
                <div
                  className="sticky top-0 z-20 px-2 py-2 text-xs font-medium text-foreground bg-secondary border-b border-r border-border"
                  title={t('tasks.stripHint')}
                >
                  {t('tasks.strip')}
                </div>
              )}
              {lifts.map((lift: Lift, i) => (
                <LiftInfo
                  key={lift.id}
                  lift={lift}
                  loadHours={loadByLift.get(lift.id) ?? 0}
                  totalHours={totalHours}
                  next={state.nextSlotByLift.get(lift.id)}
                  // `last:` тут не діє — за шапкою в тій самій сітці йде тіло; межу прибирає індекс,
                  // інакше остання колонка шапки на 1 px ширша за колонку тіла.
                  className={`sticky top-0 z-20 px-3 py-2 border-b ${i < lifts.length - 1 ? 'border-r' : ''}`}
                />
              ))}

              {/* Тіло: колонка годин — вісь часу для перетягування й малювання. Липка вліво: при
                  багатьох підйомниках сітка прокручується вбік, а підписи годин лишаються видно.
                  z-16 — над блоками записів (z-10) і лінією «зараз» (z-15), під шапкою (z-20). */}
              <div
                ref={hoursTrackRef}
                className="sticky left-0 z-16 border-r border-border bg-secondary"
              >
                {hours.map((h, i) => (
                  <div
                    key={h}
                    className="absolute inset-x-0 px-2 text-xs text-muted-foreground tabular-nums -translate-y-px"
                    style={{ top: `calc(${(i / totalHours) * 100}% + 2px)` }}
                  >
                    {pad(h)}:00
                  </div>
                ))}
              </div>
              {hasTasks && (
                <div className="relative border-r border-border">
                  <CalendarTaskStrip
                    tasks={tasks}
                    date={date}
                    windowStart={windowStart}
                    windowEnd={windowEnd}
                    vertical
                    onOpen={onOpenTask}
                  />
                </div>
              )}
              {lifts.map((lift: Lift) => (
                <LiftLane
                  key={lift.id}
                  {...laneData(lift.id)}
                  vertical
                  className="border-r border-border last:border-r-0"
                >
                  {/* Лінії годин */}
                  <div className="absolute inset-0 flex flex-col pointer-events-none">
                    {hours.map(h => (
                      <div key={h} className="flex-1 border-b last:border-b-0 border-border" />
                    ))}
                  </div>
                </LiftLane>
              ))}
            </div>
          </div>
        </DndContext>
      )}

      <UnassignedSlots
        slots={state.unassignedSlots}
        canManage={state.canManageSlots}
        onRemove={id => void state.removeSlot(id)}
      />
    </div>
  );
}
