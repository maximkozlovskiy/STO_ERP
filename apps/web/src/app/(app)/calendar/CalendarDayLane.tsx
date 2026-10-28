'use client';

import {
  memo,
  useCallback,
  useMemo,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useDroppable } from '@dnd-kit/core';

import { Spinner } from '@/components/ui/spinner';
import { fmtQty } from '@/lib/format';

import type { BookingSlot, CalendarSlot, GhostSlot, Lift, PendingSlot } from './calendar.types';
import { decimalHoursToHHMM, fmtTime } from './calendar.utils';
import { daySlotCategory, liftLoadHours } from './calendar-day';
import type { CalendarState } from './useCalendarState';
import { BookingSlotBlock, DraggableSlot, PendingSlotBlock, axisPos } from './CalendarDayBlocks';

const EMPTY_BOOKINGS: BookingSlot[] = [];

/** Дані доріжки одного підйомника — рядка планувальника чи колонки «Годин» (BR-CAL-014). */
export interface LiftLaneData {
  liftId: string;
  liftSlots: CalendarSlot[];
  liftBookings: BookingSlot[];
  ghost: GhostSlot | null;
  pending: PendingSlot | null;
  editingSlotId: string | null;
  canManage: boolean;
  /** Минулий час — частка осі від її початку, % (BR-CAL-011). */
  blockedPct: number;
  /** Лінія «зараз», % осі; `null` — не сьогодні або поза робочими годинами (BR-CAL-011). */
  nowLine: number | null;
  /** Кінці ланцюжків записів дня — для «прострочено» (BR-CAL-008/011). */
  chainEnds: ReadonlyMap<string, number>;
  nowMs: number;
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

// Від `--color-foreground`, а не чорного: у темній темі чорні смуги на темному фоні не видно, і
// минулі години не виглядали приглушеними (BR-CAL-011).
const PAST_HATCH: CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(135deg, transparent 0px, transparent 6px, color-mix(in srgb, var(--color-foreground) 8%, transparent) 6px, color-mix(in srgb, var(--color-foreground) 8%, transparent) 8px)',
  backgroundColor: 'color-mix(in srgb, var(--color-foreground) 4%, transparent)',
};

/**
 * Доріжка підйомника: ціль перетягування (`data-lift-id` — для малювання), минулий час, привид
 * малювання, чернетка, записи, онлайн-бронювання й лінія «зараз». Розмітку сітки (лінії годин)
 * дає `children`; `vertical` — повернута сітка, час іде згори вниз.
 */
export const LiftLane = memo(function LiftLane({
  vertical,
  className,
  style,
  children,
  ...p
}: LiftLaneData & {
  vertical: boolean;
  className: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `lift-${p.liftId}`,
    data: { liftId: p.liftId },
  });
  const { ghost, windowStart, totalHours } = p;
  const showGhost = ghost?.liftId === p.liftId && ghost.endH > ghost.startH;
  const cross = vertical ? 'left-1 right-1' : 'top-1 bottom-1';

  return (
    <div
      ref={setNodeRef}
      className={`${className} relative transition-colors ${isOver ? 'bg-primary/5' : ''}`}
      style={style}
      data-lift-id={p.liftId}
    >
      {children}

      {p.blockedPct > 0 && (
        <div
          className={`absolute pointer-events-none z-1 ${vertical ? 'inset-x-0 top-0' : 'inset-y-0 left-0'}`}
          style={{
            ...PAST_HATCH,
            ...(vertical ? { height: `${p.blockedPct}%` } : { width: `${p.blockedPct}%` }),
          }}
          aria-hidden
        >
          {p.blockedPct < 100 && (
            <div
              className={`absolute bg-foreground/20 ${vertical ? 'inset-x-0 bottom-0 h-0.5' : 'inset-y-0 right-0 w-0.5'}`}
            />
          )}
        </div>
      )}

      {showGhost && (
        <div
          className={`absolute ${cross} bg-primary/30 border-2 border-primary border-dashed rounded pointer-events-none z-5`}
          style={axisPos(
            vertical,
            ((ghost.startH - windowStart) / totalHours) * 100,
            ((ghost.endH - ghost.startH) / totalHours) * 100,
          )}
        >
          <span className="text-xs text-primary px-1.5 font-medium">
            {decimalHoursToHHMM(ghost.startH)}–{decimalHoursToHHMM(ghost.endH)}
          </span>
        </div>
      )}

      {p.pending?.liftId === p.liftId && (
        <PendingSlotBlock
          pending={p.pending}
          windowStart={windowStart}
          totalHours={totalHours}
          vertical={vertical}
          onOpen={p.onPendingOpen}
          onCancel={p.onPendingCancel}
          onPendingResizeStart={p.onPendingResizeStart}
        />
      )}

      {p.liftSlots.map(s => (
        <DraggableSlot
          key={s.id}
          slot={s}
          category={daySlotCategory(s, p.chainEnds, p.nowMs)}
          isEditing={s.id === p.editingSlotId}
          canManage={p.canManage}
          windowStart={windowStart}
          totalHours={totalHours}
          vertical={vertical}
          onEdit={p.onEdit}
          onResizeStart={p.onResizeStart}
        />
      ))}

      {p.liftBookings.map(b => (
        <BookingSlotBlock
          key={b.id}
          slot={b}
          windowStart={windowStart}
          windowEnd={p.windowEnd}
          totalHours={totalHours}
          vertical={vertical}
        />
      ))}

      {p.nowLine !== null && (
        <div
          className={`absolute bg-destructive pointer-events-none z-15 ${vertical ? 'inset-x-0 h-0.5 -translate-y-1/2' : 'inset-y-0 w-0.5 -translate-x-1/2'}`}
          style={vertical ? { top: `${p.nowLine}%` } : { left: `${p.nowLine}%` }}
          data-testid="now-line"
          aria-hidden="true"
        />
      )}
    </div>
  );
});

/**
 * Спільне для обох сіток «Дня»: бронювання й завантаження за підйомником (BR-CAL-011) і дані
 * доріжки підйомника зі стану календаря.
 */
export function useLiftLanes(state: CalendarState) {
  const { bookingSlots, lifts, slots, date, windowStart, windowEnd } = state;
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

  const laneData = useCallback(
    (liftId: string): LiftLaneData => ({
      liftId,
      liftSlots: state.slotsByLift.get(liftId) ?? state.EMPTY_SLOTS,
      liftBookings: bookingsByLift.get(liftId) ?? EMPTY_BOOKINGS,
      ghost: state.ghost,
      pending: state.pendingSlot,
      editingSlotId: state.editingSlotId,
      canManage: state.canManageSlots,
      blockedPct: state.blockedWidth,
      nowLine: state.nowLine,
      chainEnds: state.dayChainEnds,
      nowMs: state.nowMs,
      windowStart: state.windowStart,
      windowEnd: state.windowEnd,
      totalHours: state.totalHours,
      onEdit: state.handleEditSlot,
      onResizeStart: state.handleResizeStart,
      onPendingOpen: state.openFormFromPending,
      onPendingCancel: state.cancelPending,
      onPendingResizeStart: state.handlePendingResizeStart,
    }),
    [state, bookingsByLift],
  );

  return { loadByLift, laneData };
}

/** Підказки, завантаження й «немає підйомників» над сіткою «Дня» — однаково в обох режимах. */
export function DayGridStatus({ state, hintKey }: { state: CalendarState; hintKey: string }) {
  const { t } = useTranslation('calendar');
  const { canManageSlots, loading, lifts, pendingSlot, showAdd } = state;
  return (
    <>
      {/* Підказка про малювання й перетягування — лише тим, кому це доступно (BR-CAL-010) */}
      {canManageSlots && !loading && lifts.length > 0 && !pendingSlot && !showAdd && (
        <p className="text-xs text-muted-foreground mb-2">{t(hintKey)}</p>
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
    </>
  );
}

/**
 * Опис підйомника в сітці «Дня»: назва, завантаження за день «N год з M» (BR-CAL-011) і
 * «зараз» / «↓ наступний запис». `className` — розмітка клітинки конкретної сітки.
 */
export function LiftInfo({
  lift,
  loadHours,
  totalHours,
  next,
  className,
}: {
  lift: Lift;
  loadHours: number;
  totalHours: number;
  next: string | undefined;
  className: string;
}) {
  const { t } = useTranslation('calendar');
  return (
    <div className={`bg-secondary border-border flex flex-col gap-0.5 ${className}`}>
      <span
        className="text-sm font-medium text-foreground leading-tight truncate"
        title={lift.name}
      >
        {lift.name}
      </span>
      {/* `text-foreground`: muted на `bg-secondary` — лише 4,3:1 у світлій темі */}
      <span
        className="text-[11px] text-foreground leading-none tabular-nums"
        title={t('day.liftLoadTitle')}
        data-testid="lift-load"
      >
        {t('day.liftLoad', { booked: fmtQty(loadHours), total: fmtQty(totalHours) })}
      </span>
      {next === 'now' ? (
        <span className="text-[10px] font-medium text-success-text leading-none">
          {t('day.now')}
        </span>
      ) : next ? (
        <span className="text-[10px] text-muted-foreground leading-none">↓ {fmtTime(next)}</span>
      ) : null}
    </div>
  );
}
