'use client';

import { useTranslation } from 'react-i18next';
import { DndContext } from '@dnd-kit/core';

import type { Lift } from './calendar.types';
import { SIDEBAR_W, pad } from './calendar.utils';
import { type CalendarState } from './useCalendarState';
import { CalendarTaskStrip } from './CalendarTaskStrip';
import { UnassignedSlots } from './CalendarDayBlocks';
import { DayGridStatus, LiftInfo, LiftLane, useLiftLanes } from './CalendarDayLane';
import type { CalendarTask } from './calendar-tasks';

interface CalendarDayGridProps {
  state: CalendarState;
  /** Задачі дня — смуга «Задачі» над підйомниками (BR-TASK-007); не займають підйомник. */
  tasks?: readonly CalendarTask[];
  onOpenTask?: (task: CalendarTask) => void;
}

const NO_TASKS: readonly CalendarTask[] = [];
const noop = () => {};

/**
 * Вид «День», планувальник: рядки — підйомники, колонки — години (BR-CAL-014, типовий режим).
 * Підказки, шапка годин, смуга «Задачі», рядки підйомників із малюванням, перетягуванням і зміною
 * меж, перелік «Без підйомника». Стан і обробники — з `useCalendarState()` через `state`.
 */
export function CalendarDayGrid({
  state,
  tasks = NO_TASKS,
  onOpenTask = noop,
}: CalendarDayGridProps) {
  const { t } = useTranslation('calendar');
  const { loadByLift, laneData } = useLiftLanes(state);
  const { lifts, hours, totalHours, nowLine } = state;
  const columns = `${SIDEBAR_W}px repeat(${totalHours}, 1fr)`;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <DayGridStatus state={state} hintKey="day.hintDraw" />

      {!state.loading && lifts.length > 0 && (
        <DndContext
          sensors={state.sensors}
          onDragEnd={e => {
            void state.handleDragEnd(e);
          }}
        >
          {/* flex-1 wrapper so DndContext (which renders no DOM) doesn't break flex chain */}
          <div className="flex-1 min-h-0 flex flex-col">
            <div
              ref={state.timelineRef}
              className="bg-surface border border-border rounded-xl flex flex-col flex-1 min-h-0 overflow-hidden"
            >
              {/* Sticky header — fixed inside the rounded container, z-20 above draggable slots (z-10/z-50) */}
              <div
                className="grid border-b border-border shrink-0 z-20 relative"
                style={{ gridTemplateColumns: columns }}
              >
                <div className="px-3 py-2 text-xs font-medium text-muted-foreground bg-secondary border-r border-border">
                  {t('day.colLift')}
                </div>
                {hours.map(h => (
                  <div
                    key={h}
                    className="px-1 py-2 text-xs text-center text-muted-foreground bg-secondary border-r border-border last:border-r-0"
                  >
                    {pad(h)}:00
                  </div>
                ))}
                {/* Позначка «зараз» у шапці — коротка, щоб не перекривати підпис години */}
                {nowLine !== null && (
                  <div
                    className="absolute bottom-0 h-2 w-0.5 -translate-x-1/2 bg-destructive pointer-events-none"
                    style={{
                      left: `calc(${SIDEBAR_W}px + (100% - ${SIDEBAR_W}px) * ${nowLine / 100})`,
                    }}
                    aria-hidden="true"
                  />
                )}
              </div>
              {/* Смуга «Задачі» — поза рядками підйомників: блоки не drag-ються й не займають пост */}
              <CalendarTaskStrip
                tasks={tasks}
                date={state.date}
                windowStart={state.windowStart}
                windowEnd={state.windowEnd}
                onOpen={onOpenTask}
              />
              {/* Scrollable rows — flex-1 so rows fill remaining height; scrollbar stays below header */}
              <div className="overflow-x-auto overflow-y-auto flex-1 min-h-0">
                {lifts.map((lift: Lift) => (
                  <div
                    key={lift.id}
                    className="grid border-b border-border last:border-b-0"
                    style={{ gridTemplateColumns: columns }}
                  >
                    <LiftInfo
                      lift={lift}
                      loadHours={loadByLift.get(lift.id) ?? 0}
                      totalHours={totalHours}
                      next={state.nextSlotByLift.get(lift.id)}
                      className="px-3 py-3 min-h-20 justify-center border-r"
                    />
                    <LiftLane
                      {...laneData(lift.id)}
                      vertical={false}
                      className="col-span-12 min-h-28"
                      style={{ gridColumn: `2 / span ${totalHours}` }}
                    >
                      <div className="flex h-full pointer-events-none">
                        {hours.map(h => (
                          <div
                            key={h}
                            className="flex-1 border-r last:border-r-0 border-border min-h-28"
                          />
                        ))}
                      </div>
                    </LiftLane>
                  </div>
                ))}
              </div>
              {/* end overflow-x-auto rows */}
            </div>
          </div>
          {/* end flex-1 DndContext wrapper */}
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
