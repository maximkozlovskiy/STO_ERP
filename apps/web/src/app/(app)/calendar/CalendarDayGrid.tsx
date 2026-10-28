'use client';

import { memo, useMemo, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { DndContext, useDroppable } from '@dnd-kit/core';

import { Spinner } from '@/components/ui/spinner';
import { fmtQty } from '@/lib/format';

import type { BookingSlot, CalendarSlot, GhostSlot, Lift, PendingSlot } from './calendar.types';
import { SIDEBAR_W, decimalHoursToHHMM, fmtTime, pad } from './calendar.utils';
import { daySlotCategory, liftLoadHours } from './calendar-day';
import { type CalendarState } from './useCalendarState';
import { CalendarTaskStrip } from './CalendarTaskStrip';
import {
  BookingSlotBlock,
  DraggableSlot,
  PendingSlotBlock,
  UnassignedSlots,
} from './CalendarDayBlocks';
import type { CalendarTask } from './calendar-tasks';

// Module-level stable refs — `useMemo<[]>(() => [], [])` всередині компонента
// створює новий [] на КОЖНОМУ mount, але reference стабільна між render-ами.
// Перенесення на module-level зберігає ту саму семантику + 0 alloc per mount.
const EMPTY_BOOKINGS: BookingSlot[] = [];
/** Найменша видима ширина блоку запису, год — крок сітки 15 хв. */

// ─── DroppableLiftRow ────────────────────────────────────────────────────────

interface DroppableLiftRowProps {
  liftId: string;
  liftSlots: CalendarSlot[];
  liftBookings: BookingSlot[];
  ghost: GhostSlot | null;
  pending: PendingSlot | null;
  editingSlotId: string | null;
  canManage: boolean;
  blockedWidth: number;
  /** Лінія «зараз», % ширини; `null` — не сьогодні або поза робочими годинами (BR-CAL-011). */
  nowLine: number | null;
  /** Кінці ланцюжків записів дня — для «прострочено» (BR-CAL-008/011). */
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

const DroppableLiftRow = memo(function DroppableLiftRow({
  liftId,
  liftSlots,
  liftBookings,
  ghost,
  pending,
  editingSlotId,
  canManage,
  blockedWidth,
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
}: DroppableLiftRowProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `lift-${liftId}`, data: { liftId } });

  const showGhost = ghost?.liftId === liftId && ghost.endH > ghost.startH;
  const ghostLeft = showGhost ? ((ghost.startH - windowStart) / totalHours) * 100 : 0;
  const ghostWidth = showGhost ? ((ghost.endH - ghost.startH) / totalHours) * 100 : 0;
  const showPending = pending?.liftId === liftId;

  return (
    <div
      ref={setNodeRef}
      className={`col-span-12 relative min-h-28 transition-colors ${isOver ? 'bg-primary/5' : ''}`}
      style={{ gridColumn: `2 / span ${totalHours}` }}
      data-lift-id={liftId}
    >
      <div className="flex h-full pointer-events-none">
        {hours.map(h => (
          <div key={h} className="flex-1 border-r last:border-r-0 border-border min-h-28" />
        ))}
      </div>

      {blockedWidth > 0 && (
        <div
          className="absolute inset-y-0 left-0 pointer-events-none z-1"
          style={{
            width: `${blockedWidth}%`,
            // Від `--color-foreground`, а не чорного: у темній темі чорні смуги на темному
            // фоні не видно, і минулі години не виглядали приглушеними (BR-CAL-011).
            backgroundImage:
              'repeating-linear-gradient(135deg, transparent 0px, transparent 6px, color-mix(in srgb, var(--color-foreground) 8%, transparent) 6px, color-mix(in srgb, var(--color-foreground) 8%, transparent) 8px)',
            backgroundColor: 'color-mix(in srgb, var(--color-foreground) 4%, transparent)',
          }}
          aria-hidden
        >
          {blockedWidth < 100 && (
            <div className="absolute inset-y-0 right-0 w-0.5 bg-foreground/20" />
          )}
        </div>
      )}

      {showGhost && (
        <div
          className="absolute top-1 bottom-1 bg-primary/30 border-2 border-primary border-dashed rounded pointer-events-none z-5"
          style={{ left: `${ghostLeft}%`, width: `${ghostWidth}%` }}
        >
          <span className="text-xs text-primary px-1.5 font-medium">
            {decimalHoursToHHMM(ghost.startH)}–{decimalHoursToHHMM(ghost.endH)}
          </span>
        </div>
      )}

      {showPending && (
        <PendingSlotBlock
          pending={pending}
          windowStart={windowStart}
          totalHours={totalHours}
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
        />
      ))}

      {nowLine !== null && (
        <div
          className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-destructive pointer-events-none z-15"
          style={{ left: `${nowLine}%` }}
          data-testid="now-line"
          aria-hidden="true"
        />
      )}
    </div>
  );
});

// ─── CalendarDayGrid ─────────────────────────────────────────────────────────

interface CalendarDayGridProps {
  state: CalendarState;
  /** Задачі дня — смуга «Задачі» над підйомниками (BR-TASK-007); не займають підйомник. */
  tasks?: readonly CalendarTask[];
  onOpenTask?: (task: CalendarTask) => void;
}

const NO_TASKS: readonly CalendarTask[] = [];
const noop = () => {};

/**
 * Renders the day-view: hint paragraphs, loading/empty states, DnD timeline
 * (hours header + lift rows with drag/resize/draw), and the unassigned-slots
 * list. All state and handlers come from `useCalendarState()` via `state`.
 */
export function CalendarDayGrid({
  state,
  tasks = NO_TASKS,
  onOpenTask = noop,
}: CalendarDayGridProps) {
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

  // Group booking slots by their assigned liftId
  const bookingsByLift = useMemo(() => {
    const map = new Map<string, BookingSlot[]>();
    for (const b of bookingSlots) {
      const arr = map.get(b.liftId) ?? [];
      arr.push(b);
      map.set(b.liftId, arr);
    }
    return map;
  }, [bookingSlots]);

  // Завантаження кожного підйомника за день — зі збережених записів дня (BR-CAL-011).
  const loadByLift = useMemo(() => {
    const map = new Map<string, number>();
    for (const lift of lifts) {
      map.set(lift.id, liftLoadHours(slots, lift.id, date, windowStart, windowEnd));
    }
    return map;
  }, [lifts, slots, date, windowStart, windowEnd]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ── Hint ───────────────────────────────────────────────────────────── */}
      {/* Підказка про малювання й перетягування — лише тим, кому це доступно (BR-CAL-010) */}
      {canManageSlots && !loading && lifts.length > 0 && !pendingSlot && !showAdd && (
        <p className="text-xs text-muted-foreground mb-2">{t('day.hintDraw')}</p>
      )}
      {pendingSlot && !showAdd && (
        <p className="text-xs text-primary mb-2 font-medium">{t('day.hintPending')}</p>
      )}

      {/* ── Loading / empty ────────────────────────────────────────────────── */}
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

      {/* ── DnD timeline ───────────────────────────────────────────────────── */}
      {!loading && lifts.length > 0 && (
        <DndContext
          sensors={sensors}
          onDragEnd={e => {
            void handleDragEnd(e);
          }}
        >
          {/* flex-1 wrapper so DndContext (which renders no DOM) doesn't break flex chain */}
          <div className="flex-1 min-h-0 flex flex-col">
            <div
              ref={timelineRef}
              className="bg-surface border border-border rounded-xl flex flex-col flex-1 min-h-0 overflow-hidden"
            >
              {/* Sticky header — fixed inside the rounded container, z-20 above draggable slots (z-10/z-50) */}
              <div
                className="grid border-b border-border shrink-0 z-20 relative"
                style={{ gridTemplateColumns: `${SIDEBAR_W}px repeat(${totalHours}, 1fr)` }}
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
                date={date}
                windowStart={windowStart}
                windowEnd={windowEnd}
                onOpen={onOpenTask}
              />
              {/* Scrollable rows — flex-1 so rows fill remaining height; scrollbar stays below header */}
              <div className="overflow-x-auto overflow-y-auto flex-1 min-h-0">
                {lifts.map((lift: Lift) => (
                  <div
                    key={lift.id}
                    className="grid border-b border-border last:border-b-0"
                    style={{ gridTemplateColumns: `${SIDEBAR_W}px repeat(${totalHours}, 1fr)` }}
                  >
                    <div className="px-3 py-3 min-h-20 bg-secondary border-r border-border flex flex-col justify-center gap-0.5">
                      <span className="text-sm font-medium text-foreground leading-tight">
                        {lift.name}
                      </span>
                      {/* `text-foreground`: muted на `bg-secondary` — лише 4,3:1 у світлій темі */}
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
                    <DroppableLiftRow
                      liftId={lift.id}
                      liftSlots={slotsByLift.get(lift.id) ?? EMPTY_SLOTS}
                      liftBookings={bookingsByLift.get(lift.id) ?? EMPTY_BOOKINGS}
                      ghost={ghost}
                      pending={pendingSlot}
                      editingSlotId={editingSlotId}
                      canManage={canManageSlots}
                      blockedWidth={blockedWidth}
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
                  </div>
                ))}
              </div>
              {/* end overflow-x-auto rows */}
            </div>
          </div>
          {/* end flex-1 DndContext wrapper */}
        </DndContext>
      )}

      {/* ── Unassigned slots ───────────────────────────────────────────────── */}
      <UnassignedSlots
        slots={unassignedSlots}
        canManage={canManageSlots}
        onRemove={id => void removeSlot(id)}
      />
    </div>
  );
}
