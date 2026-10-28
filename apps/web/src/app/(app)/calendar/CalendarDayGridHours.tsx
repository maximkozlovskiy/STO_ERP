'use client';

import { memo, useMemo, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { DndContext, useDroppable } from '@dnd-kit/core';

import { Spinner } from '@/components/ui/spinner';
import { fmtQty } from '@/lib/format';

import type { BookingSlot, CalendarSlot, GhostSlot, Lift, PendingSlot } from './calendar.types';
import { decimalHoursToHHMM, fmtTime, pad } from './calendar.utils';
import { daySlotCategory, liftLoadHours } from './calendar-day';
import { type CalendarState } from './useCalendarState';
import { CalendarTaskStrip } from './CalendarTaskStrip';
import {
  BookingSlotBlock,
  DraggableSlot,
  PendingSlotBlock,
  UnassignedSlots,
  axisPos,
} from './CalendarDayBlocks';
import { taskDayBlock, type CalendarTask } from './calendar-tasks';

/** Висота години в повернутій сітці, px: 15 хв — 14 px, блок у 30 хв ще читається. */
const HOUR_PX = 56;
/** Колонка підписів годин, px. */
const TIME_COL_PX = 64;
const EMPTY_BOOKINGS: BookingSlot[] = [];

// ─── DroppableLiftColumn ─────────────────────────────────────────────────────

interface DroppableLiftColumnProps {
  liftId: string;
  liftSlots: CalendarSlot[];
  liftBookings: BookingSlot[];
  ghost: GhostSlot | null;
  pending: PendingSlot | null;
  editingSlotId: string | null;
  canManage: boolean;
  /** Минулий час — частка висоти зверху, % (BR-CAL-011). */
  blockedPct: number;
  nowLine: number | null;
  chainEnds: ReadonlyMap<string, number>;
  nowMs: number;
  hours: number[];
  windowStart: number;
  windowEnd: number;
  totalHours: number;
  onEdit: (slot: CalendarSlot) => void;
  onResizeStart: (
    e: ReactPointerEvent<HTMLDivElement>,
    slotId: string,
    edge: 'start' | 'end',
  ) => void;
  onPendingOpen: () => void;
  onPendingCancel: () => void;
  onPendingResizeStart: (e: ReactPointerEvent<HTMLDivElement>, edge: 'start' | 'end') => void;
}

const DroppableLiftColumn = memo(function DroppableLiftColumn({
  liftId,
  liftSlots,
  liftBookings,
  ghost,
  pending,
  editingSlotId,
  canManage,
  blockedPct,
  nowLine,
  chainEnds,
  nowMs,
  hours,
  windowStart,
  windowEnd,
  totalHours,
  onEdit,
  onResizeStart,
  onPendingOpen,
  onPendingCancel,
  onPendingResizeStart,
}: DroppableLiftColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `lift-${liftId}`, data: { liftId } });
  const showGhost = ghost?.liftId === liftId && ghost.endH > ghost.startH;

  return (
    <div
      ref={setNodeRef}
      className={`relative border-r border-border last:border-r-0 transition-colors ${isOver ? 'bg-primary/5' : ''}`}
      data-lift-id={liftId}
    >
      {/* Лінії годин */}
      <div className="absolute inset-0 flex flex-col pointer-events-none">
        {hours.map(h => (
          <div key={h} className="flex-1 border-b last:border-b-0 border-border" />
        ))}
      </div>

      {blockedPct > 0 && (
        <div
          className="absolute inset-x-0 top-0 pointer-events-none z-1"
          style={{
            height: `${blockedPct}%`,
            backgroundImage:
              'repeating-linear-gradient(135deg, transparent 0px, transparent 6px, color-mix(in srgb, var(--color-foreground) 8%, transparent) 6px, color-mix(in srgb, var(--color-foreground) 8%, transparent) 8px)',
            backgroundColor: 'color-mix(in srgb, var(--color-foreground) 4%, transparent)',
          }}
          aria-hidden
        />
      )}

      {showGhost && (
        <div
          className="absolute left-1 right-1 bg-primary/30 border-2 border-primary border-dashed rounded pointer-events-none z-5"
          style={axisPos(
            true,
            ((ghost.startH - windowStart) / totalHours) * 100,
            ((ghost.endH - ghost.startH) / totalHours) * 100,
          )}
        >
          <span className="text-xs text-primary px-1.5 font-medium">
            {decimalHoursToHHMM(ghost.startH)}–{decimalHoursToHHMM(ghost.endH)}
          </span>
        </div>
      )}

      {pending?.liftId === liftId && (
        <PendingSlotBlock
          pending={pending}
          windowStart={windowStart}
          totalHours={totalHours}
          vertical
          onOpen={onPendingOpen}
          onCancel={onPendingCancel}
          onPendingResizeStart={onPendingResizeStart}
        />
      )}

      {liftSlots.map(s => (
        <DraggableSlot
          key={s.id}
          slot={s}
          category={daySlotCategory(s, chainEnds, nowMs)}
          isEditing={s.id === editingSlotId}
          canManage={canManage}
          windowStart={windowStart}
          totalHours={totalHours}
          vertical
          onEdit={onEdit}
          onResizeStart={onResizeStart}
        />
      ))}

      {liftBookings.map(b => (
        <BookingSlotBlock
          key={b.id}
          slot={b}
          windowStart={windowStart}
          windowEnd={windowEnd}
          totalHours={totalHours}
          vertical
        />
      ))}

      {nowLine !== null && (
        <div
          className="absolute inset-x-0 h-0.5 -translate-y-1/2 bg-destructive pointer-events-none z-15"
          style={{ top: `${nowLine}%` }}
          data-testid="now-line"
          aria-hidden="true"
        />
      )}
    </div>
  );
});

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
export function CalendarDayGridHours({ state, tasks = NO_TASKS, onOpenTask = noop }: Props) {
  const { t } = useTranslation('calendar');
  const {
    loading,
    lifts,
    bookingSlots,
    slotsByLift,
    unassignedSlots,
    nextSlotByLift,
    EMPTY_SLOTS,
    blockedWidth,
    nowLine,
    dayChainEnds,
    nowMs,
    slots,
    date,
    pendingSlot,
    ghost,
    editingSlotId,
    showAdd,
    sensors,
    timelineRef,
    hoursTrackRef,
    handleDragEnd,
    removeSlot,
    handleEditSlot,
    handleResizeStart,
    openFormFromPending,
    cancelPending,
    handlePendingResizeStart,
    hours,
    windowStart,
    windowEnd,
    totalHours,
    canManageSlots,
  } = state;

  const bookingsByLift = useMemo(() => {
    const map = new Map<string, BookingSlot[]>();
    for (const b of bookingSlots) {
      const arr = map.get(b.liftId) ?? [];
      arr.push(b);
      map.set(b.liftId, arr);
    }
    return map;
  }, [bookingSlots]);

  const loadByLift = useMemo(() => {
    const map = new Map<string, number>();
    for (const lift of lifts) {
      map.set(lift.id, liftLoadHours(slots, lift.id, date, windowStart, windowEnd));
    }
    return map;
  }, [lifts, slots, date, windowStart, windowEnd]);

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
      {canManageSlots && !loading && lifts.length > 0 && !pendingSlot && !showAdd && (
        <p className="text-xs text-muted-foreground mb-2">{t('day.hintDrawHours')}</p>
      )}
      {pendingSlot && !showAdd && (
        <p className="text-xs text-primary mb-2 font-medium">{t('day.hintPending')}</p>
      )}

      {loading && (
        <div className="flex justify-center py-8">
          <Spinner size="md" />
        </div>
      )}

      {!loading && lifts.length === 0 && (
        <div className="bg-surface border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
          {t('day.noLifts')}{' '}
          <a href="/infrastructure" className="text-primary hover:underline">
            {t('day.infrastructure')}
          </a>
          .
        </div>
      )}

      {!loading && lifts.length > 0 && (
        <DndContext
          sensors={sensors}
          onDragEnd={e => {
            void handleDragEnd(e);
          }}
        >
          <div
            ref={timelineRef}
            className="bg-surface border border-border rounded-xl flex-1 min-h-0 overflow-auto"
            data-testid="day-grid-hours"
          >
            <div className="grid min-w-max" style={{ gridTemplateColumns: columns }}>
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
                <div
                  key={lift.id}
                  // `last:` тут не діє — за шапкою в тій самій сітці йде тіло; межу прибирає індекс,
                  // інакше остання колонка шапки на 1 px ширша за колонку тіла.
                  className={`sticky top-0 z-20 px-3 py-2 bg-secondary border-b border-border flex flex-col gap-0.5 ${i < lifts.length - 1 ? 'border-r' : ''}`}
                >
                  <span className="text-sm font-medium text-foreground leading-tight truncate">
                    {lift.name}
                  </span>
                  <span
                    className="text-[11px] text-foreground leading-none tabular-nums"
                    title={t('day.liftLoadTitle')}
                    data-testid="lift-load"
                  >
                    {t('day.liftLoad', {
                      booked: fmtQty(loadByLift.get(lift.id) ?? 0),
                      total: fmtQty(totalHours),
                    })}
                  </span>
                  {nextSlotByLift.get(lift.id) === 'now' ? (
                    <span className="text-[10px] font-medium text-success-text leading-none">
                      {t('day.now')}
                    </span>
                  ) : nextSlotByLift.has(lift.id) ? (
                    <span className="text-[10px] text-muted-foreground leading-none">
                      ↓ {fmtTime(nextSlotByLift.get(lift.id)!)}
                    </span>
                  ) : null}
                </div>
              ))}

              {/* Тіло: колонка годин — вісь часу для перетягування й малювання. Липка вліво: при
                  багатьох підйомниках сітка прокручується вбік, а підписи годин лишаються видно.
                  z-16 — над блоками записів (z-10) і лінією «зараз» (z-15), під шапкою (z-20). */}
              <div
                ref={hoursTrackRef}
                className="sticky left-0 z-16 border-r border-border bg-secondary"
                style={{ height: bodyHeight }}
              >
                {hours.map((h, i) => (
                  <div
                    key={h}
                    className="absolute inset-x-0 px-2 text-xs text-muted-foreground tabular-nums -translate-y-px"
                    style={{ top: i * HOUR_PX + 2 }}
                  >
                    {pad(h)}:00
                  </div>
                ))}
              </div>
              {hasTasks && (
                <div className="relative border-r border-border" style={{ height: bodyHeight }}>
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
                <DroppableLiftColumn
                  key={lift.id}
                  liftId={lift.id}
                  liftSlots={slotsByLift.get(lift.id) ?? EMPTY_SLOTS}
                  liftBookings={bookingsByLift.get(lift.id) ?? EMPTY_BOOKINGS}
                  ghost={ghost}
                  pending={pendingSlot}
                  editingSlotId={editingSlotId}
                  canManage={canManageSlots}
                  blockedPct={blockedWidth}
                  nowLine={nowLine}
                  chainEnds={dayChainEnds}
                  nowMs={nowMs}
                  hours={hours}
                  windowStart={windowStart}
                  windowEnd={windowEnd}
                  totalHours={totalHours}
                  onEdit={handleEditSlot}
                  onResizeStart={handleResizeStart}
                  onPendingOpen={openFormFromPending}
                  onPendingCancel={cancelPending}
                  onPendingResizeStart={handlePendingResizeStart}
                />
              ))}
            </div>
          </div>
        </DndContext>
      )}

      <UnassignedSlots
        slots={unassignedSlots}
        canManage={canManageSlots}
        onRemove={id => void removeSlot(id)}
      />
    </div>
  );
}
