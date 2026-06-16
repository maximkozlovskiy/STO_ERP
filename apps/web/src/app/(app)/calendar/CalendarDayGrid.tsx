'use client';

import { memo, useMemo, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Trash2, Plus } from 'lucide-react';
import { DndContext, useDraggable, useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { WO_STATUS_LABELS } from '@sto/shared';

import type { BookingSlot, CalendarSlot, GhostSlot, Lift, PendingSlot } from './calendar.types';
import { SIDEBAR_W, decimalHoursToHHMM, fmtTime, kyivHours, pad } from './calendar.utils';
import { PENDING_DRAG_ID, type CalendarState } from './useCalendarState';

// Module-level stable refs — `useMemo<[]>(() => [], [])` всередині компонента
// створює новий [] на КОЖНОМУ mount, але reference стабільна між render-ами.
// Перенесення на module-level зберігає ту саму семантику + 0 alloc per mount.
const EMPTY_BOOKINGS: BookingSlot[] = [];

// ─── DraggableSlot ───────────────────────────────────────────────────────────

interface DraggableSlotProps {
  slot: CalendarSlot;
  isEditing: boolean;
  windowStart: number;
  totalHours: number;
  onEdit: (slot: CalendarSlot) => void;
  onResizeStart: (
    e: ReactPointerEvent<HTMLDivElement>,
    slotId: string,
    edge: 'start' | 'end',
  ) => void;
}

const DraggableSlot = memo(function DraggableSlot({
  slot,
  isEditing,
  windowStart,
  totalHours,
  onEdit,
  onResizeStart,
}: DraggableSlotProps) {
  const startH = kyivHours(slot.startAt);
  const endH = kyivHours(slot.endAt);
  const left = ((startH - windowStart) / totalHours) * 100;
  const width = ((endH - startH) / totalHours) * 100;

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: slot.id,
    data: { slot },
  });
  const style: CSSProperties = {
    left: `${left}%`,
    width: `${width}%`,
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : 10,
  };

  const timeLabel = `${fmtTime(slot.startAt)}–${fmtTime(slot.endAt)}`;
  const titleTooltip = [
    timeLabel,
    slot.workOrderNumber ? `· ${slot.workOrderNumber}` : null,
    slot.workOrderStatus ? (WO_STATUS_LABELS[slot.workOrderStatus] ?? slot.workOrderStatus) : null,
    slot.counterpartyName ?? null,
    slot.cpPhone ?? null,
    slot.vehicleSummary ?? null,
    slot.vehiclePlate ?? null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-calendar-slot
      className={`absolute top-1 bottom-1 rounded text-white text-xs overflow-hidden group select-none ring-2 ring-offset-1 flex flex-col ${isEditing ? 'bg-amber-500 ring-amber-400' : 'bg-primary ring-transparent'}`}
      title={titleTooltip}
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-white/20 rounded-l flex items-center justify-center"
        onPointerDown={e => {
          e.stopPropagation();
          onResizeStart(e, slot.id, 'start');
        }}
        aria-label="Змінити початок"
      >
        <div className="w-0.5 h-4 bg-white/50 rounded" />
      </div>

      <div
        className="flex-1 flex flex-col px-3 cursor-grab active:cursor-grabbing min-w-0 py-1 relative"
        {...listeners}
        {...attributes}
        onClick={() => onEdit(slot)}
      >
        {/* Time — top-left, small */}
        <span className="text-[10px] leading-none opacity-75 mb-1">
          {timeLabel}
          {slot.parentSlotId && <span className="ml-1 opacity-60">↩</span>}
        </span>
        {/* Main info — centered */}
        <div className="flex-1 flex flex-col justify-center gap-0.5 min-w-0">
          {slot.workOrderNumber && (
            <span className="font-medium truncate leading-tight">{slot.workOrderNumber}</span>
          )}
          {slot.workOrderStatus && (
            <span className="truncate leading-tight text-[10px] opacity-90">
              {WO_STATUS_LABELS[slot.workOrderStatus] ?? slot.workOrderStatus}
            </span>
          )}
          {slot.counterpartyName && (
            <span className="truncate leading-tight">{slot.counterpartyName}</span>
          )}
          {slot.cpPhone && (
            <span className="truncate leading-tight opacity-75">{slot.cpPhone}</span>
          )}
          {slot.vehicleSummary && (
            <span className="truncate leading-tight opacity-75">{slot.vehicleSummary}</span>
          )}
          {slot.vehiclePlate && (
            <span className="truncate leading-tight opacity-75">{slot.vehiclePlate}</span>
          )}
        </div>
      </div>

      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-white/20 rounded-r flex items-center justify-center"
        onPointerDown={e => {
          e.stopPropagation();
          onResizeStart(e, slot.id, 'end');
        }}
        aria-label="Змінити кінець"
      >
        <div className="w-0.5 h-4 bg-white/50 rounded" />
      </div>
    </div>
  );
});

// ─── PendingSlotBlock ────────────────────────────────────────────────────────

interface PendingSlotBlockProps {
  pending: PendingSlot;
  windowStart: number;
  totalHours: number;
  onOpen: () => void;
  onCancel: () => void;
  onPendingResizeStart: (e: ReactPointerEvent<HTMLDivElement>, edge: 'start' | 'end') => void;
}

const PendingSlotBlock = memo(function PendingSlotBlock({
  pending,
  windowStart,
  totalHours,
  onOpen,
  onCancel,
  onPendingResizeStart,
}: PendingSlotBlockProps) {
  const left = ((pending.startH - windowStart) / totalHours) * 100;
  const width = ((pending.endH - pending.startH) / totalHours) * 100;

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: PENDING_DRAG_ID,
    data: { isPending: true },
  });

  const style: CSSProperties = {
    left: `${left}%`,
    width: `${width}%`,
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : 10,
  };

  return (
    <div
      ref={setNodeRef}
      data-pending-slot
      className="absolute top-1 bottom-1 bg-primary/20 border-2 border-primary rounded flex items-center overflow-hidden group select-none z-10"
      style={style}
      title="Перетягніть щоб змінити підйомник або час. Натисніть щоб відкрити форму"
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-primary/20 rounded-l flex items-center justify-center"
        onPointerDown={e => {
          e.stopPropagation();
          onPendingResizeStart(e, 'start');
        }}
        aria-label="Змінити початок"
      >
        <div className="w-0.5 h-4 bg-primary/60 rounded" />
      </div>

      <span
        className="flex-1 text-xs text-primary font-medium px-3 truncate cursor-grab active:cursor-grabbing"
        onClick={onOpen}
        {...listeners}
        {...attributes}
      >
        {decimalHoursToHHMM(pending.startH)}–{decimalHoursToHHMM(pending.endH)}
      </span>

      <button
        type="button"
        onPointerDown={e => e.stopPropagation()}
        onClick={e => {
          e.stopPropagation();
          onCancel();
        }}
        className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-primary/70 hover:text-primary shrink-0"
        aria-label="Скасувати"
      >
        <Plus className="h-3 w-3 rotate-45" />
      </button>

      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-primary/20 rounded-r flex items-center justify-center"
        onPointerDown={e => {
          e.stopPropagation();
          onPendingResizeStart(e, 'end');
        }}
        aria-label="Змінити кінець"
      >
        <div className="w-0.5 h-4 bg-primary/60 rounded" />
      </div>
    </div>
  );
});

// ─── BookingSlotBlock ────────────────────────────────────────────────────────

const BookingSlotBlock = memo(function BookingSlotBlock({
  slot,
  windowStart,
  windowEnd,
  totalHours,
}: {
  slot: BookingSlot;
  windowStart: number;
  windowEnd: number;
  totalHours: number;
}) {
  const startH = kyivHours(slot.startAt);
  const endH = kyivHours(slot.endAt);
  if (endH <= windowStart || startH >= windowEnd) return null;
  const clampedStart = Math.max(startH, windowStart);
  const clampedEnd = Math.min(endH, windowEnd);
  const left = ((clampedStart - windowStart) / totalHours) * 100;
  const width = ((clampedEnd - clampedStart) / totalHours) * 100;
  const timeLabel = `${fmtTime(slot.startAt)}–${fmtTime(slot.endAt)}`;

  return (
    <a
      href="/bookings"
      title={`Онлайн-запис: ${slot.clientName} ${slot.clientPhone}\n${timeLabel}`}
      className="absolute top-1 bottom-1 rounded border-2 border-dashed border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 text-xs overflow-hidden flex flex-col px-2 py-1 z-10 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors"
      style={{ left: `${left}%`, width: `${width}%` }}
    >
      <span className="text-[10px] leading-none opacity-75 mb-0.5">{timeLabel}</span>
      <span className="font-medium truncate leading-tight">{slot.clientName}</span>
      <span className="truncate leading-tight opacity-75">{slot.clientPhone}</span>
    </a>
  );
});

// ─── DroppableLiftRow ────────────────────────────────────────────────────────

interface DroppableLiftRowProps {
  liftId: string;
  liftSlots: CalendarSlot[];
  liftBookings: BookingSlot[];
  ghost: GhostSlot | null;
  pending: PendingSlot | null;
  editingSlotId: string | null;
  blockedWidth: number;
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
  blockedWidth,
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
  const ghostLeft = showGhost ? ((ghost!.startH - windowStart) / totalHours) * 100 : 0;
  const ghostWidth = showGhost ? ((ghost!.endH - ghost!.startH) / totalHours) * 100 : 0;
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
            backgroundImage:
              'repeating-linear-gradient(135deg, transparent 0px, transparent 6px, rgba(0,0,0,0.08) 6px, rgba(0,0,0,0.08) 8px)',
            backgroundColor: 'rgba(0,0,0,0.04)',
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
            {decimalHoursToHHMM(ghost!.startH)}–{decimalHoursToHHMM(ghost!.endH)}
          </span>
        </div>
      )}

      {showPending && (
        <PendingSlotBlock
          pending={pending!}
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
          isEditing={s.id === editingSlotId}
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
    </div>
  );
});

// ─── CalendarDayGrid ─────────────────────────────────────────────────────────

interface CalendarDayGridProps {
  state: CalendarState;
}

/**
 * Renders the day-view: hint paragraphs, loading/empty states, DnD timeline
 * (hours header + lift rows with drag/resize/draw), and the unassigned-slots
 * list. All state and handlers come from `useCalendarState()` via `state`.
 */
export function CalendarDayGrid({ state }: CalendarDayGridProps) {
  const {
    loading,
    lifts,
    bookingSlots,
    slotsByLift,
    unassignedSlots,
    nextSlotByLift,
    EMPTY_SLOTS,
    blockedWidth,
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

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ── Hint ───────────────────────────────────────────────────────────── */}
      {!loading && lifts.length > 0 && !pendingSlot && !showAdd && (
        <p className="text-xs text-muted-foreground mb-2">
          Затисніть і перетягніть по рядку підйомника щоб створити слот. Тягніть краї для зміни
          тривалості. Натисніть на проміжок щоб зберегти.
        </p>
      )}
      {pendingSlot && !showAdd && (
        <p className="text-xs text-primary mb-2 font-medium">
          ↑ Налаштуйте проміжок і натисніть на нього щоб відкрити форму збереження.
        </p>
      )}

      {/* ── Loading / empty ────────────────────────────────────────────────── */}
      {loading && (
        <div className="flex justify-center py-8">
          <Spinner size="md" />
        </div>
      )}

      {!loading && lifts.length === 0 && (
        <div className="bg-surface border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
          Немає підйомників. Додайте їх у розділі{' '}
          <a href="/infrastructure" className="text-primary hover:underline">
            Інфраструктура
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
                  Підйомник
                </div>
                {hours.map(h => (
                  <div
                    key={h}
                    className="px-1 py-2 text-xs text-center text-muted-foreground bg-secondary border-r border-border last:border-r-0"
                  >
                    {pad(h)}:00
                  </div>
                ))}
              </div>
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
                      {nextSlotByLift.get(lift.id) === 'now' ? (
                        <span className="text-[10px] font-medium text-success-text leading-none">
                          ● зараз
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
                      blockedWidth={blockedWidth}
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
      {unassignedSlots.length > 0 && (
        <div className="mt-6 bg-surface border border-border rounded-xl p-5">
          <h3 className="font-semibold text-foreground mb-3 text-sm">Без підйомника</h3>
          <div className="space-y-2">
            {unassignedSlots.map(s => (
              <div
                key={s.id}
                className="flex items-center justify-between px-3 py-2 bg-secondary rounded-lg"
              >
                <div>
                  <span className="text-sm text-foreground">
                    {fmtTime(s.startAt)} – {fmtTime(s.endAt)}
                  </span>
                  {s.workOrderNumber && (
                    <span className="ml-2 text-xs text-primary">Наряд {s.workOrderNumber}</span>
                  )}
                  {s.counterpartyName && (
                    <span className="ml-2 text-xs text-muted-foreground">{s.counterpartyName}</span>
                  )}
                  {s.notes && <span className="ml-2 text-xs text-muted-foreground">{s.notes}</span>}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeSlot(s.id)}
                  title="Видалити слот"
                  aria-label={`Видалити слот ${fmtTime(s.startAt)}–${fmtTime(s.endAt)}`}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
