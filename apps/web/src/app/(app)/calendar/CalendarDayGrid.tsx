'use client';

import {
  memo,
  useId,
  useMemo,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Plus, UserRound } from 'lucide-react';
import { DndContext, useDraggable, useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { woStatusLabel } from '@/i18n/enumLabel';
import { fmtQty } from '@/lib/format';

import type { BookingSlot, CalendarSlot, GhostSlot, Lift, PendingSlot } from './calendar.types';
import { SIDEBAR_W, decimalHoursToHHMM, fmtTime, kyivHours, pad } from './calendar.utils';
import {
  CATEGORY_VIEW,
  SLOT_TYPE_ICON,
  isServiceSlotType,
  slotType,
  type SlotCategory,
} from './calendar-categories';
import {
  daySlotCategory,
  isCancelledWorkOrderSlot,
  liftLoadHours,
  slotDeleteLockHint,
  workOrderTimeLock,
} from './calendar-day';
import { PENDING_DRAG_ID, type CalendarState } from './useCalendarState';
import { CalendarTaskStrip } from './CalendarTaskStrip';
import type { CalendarTask } from './calendar-tasks';

// Module-level stable refs — `useMemo<[]>(() => [], [])` всередині компонента
// створює новий [] на КОЖНОМУ mount, але reference стабільна між render-ами.
// Перенесення на module-level зберігає ту саму семантику + 0 alloc per mount.
const EMPTY_BOOKINGS: BookingSlot[] = [];
/** Найменша видима ширина блоку запису, год — крок сітки 15 хв. */
const MIN_BLOCK_H = 0.25;

// ─── DraggableSlot ───────────────────────────────────────────────────────────

interface DraggableSlotProps {
  slot: CalendarSlot;
  /** Категорія BR-CAL-008 з кінцем ланцюжка — колір і іконка блоку (BR-CAL-011). */
  category: SlotCategory;
  isEditing: boolean;
  /**
   * Право змінювати записи (BR-CAL-010). Без нього (механік) блок не перетягується, ручок зміни
   * меж і курсорів перетягування немає — лише відкриття запису для перегляду.
   */
  canManage: boolean;
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
  category,
  isEditing,
  canManage,
  windowStart,
  totalHours,
  onEdit,
  onResizeStart,
}: DraggableSlotProps) {
  const { t } = useTranslation('calendar');
  // Блок — лише видима частина запису в межах робочих годин (Bug #875): запис, що почався до
  // відкриття чи закінчується після закриття (години змінили після запису, запис через API),
  // інакше налазив на колонку підйомника — ховав назву і «N год з M» — або розширював рядок.
  // Запис цілком поза годинами — коротка позначка біля краю: його видно й можна відкрити.
  const windowEnd = windowStart + totalHours;
  const visStart = Math.min(
    Math.max(kyivHours(slot.startAt), windowStart),
    windowEnd - MIN_BLOCK_H,
  );
  const visEnd = Math.min(Math.max(kyivHours(slot.endAt), visStart + MIN_BLOCK_H), windowEnd);
  const left = ((visStart - windowStart) / totalHours) * 100;
  const width = ((visEnd - visStart) / totalHours) * 100;

  // BR-WO-027: запис наряду не в редагованому статусі («В роботі», «Виконано»…) не
  // перетягується й не розтягується — без ручок і курсору перетягування; підказка — у title.
  const lockedStatus = workOrderTimeLock(slot);
  const movable = canManage && !lockedStatus;
  // Скасований наряд: час і підйомник так само заблоковані, але запис видаляється (BR-WO-026).
  const lockedHint = (status: string) =>
    t(isCancelledWorkOrderSlot(status) ? 'day.woTimeLockedCancelled' : 'day.woTimeLocked', {
      status: woStatusLabel(status),
    });
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: slot.id,
    data: { slot },
    disabled: !movable,
  });
  // Тіло блоку — кнопка для клавіатури в обох ролях: Enter і пробіл відкривають запис. Сенсор
  // перетягування лише вказівний (`PointerSensor`), тож `listeners` клавіш не обробляють — без
  // власного `onKeyDown` фокусована «кнопка» нічого не робила (Bug #877). Механіку — без
  // «draggable» для читача екрана.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onEdit(slot);
  };
  const contentProps = movable
    ? { ...listeners, ...attributes, onKeyDown }
    : { role: 'button', tabIndex: 0, onKeyDown };
  const style: CSSProperties = {
    left: `${left}%`,
    width: `${width}%`,
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : 10,
  };

  const timeLabel = `${fmtTime(slot.startAt)}–${fmtTime(slot.endAt)}`;
  const {
    icon: CategoryIcon,
    className: categoryIconColor,
    barClassName,
    bgClassName,
  } = CATEGORY_VIEW[category];
  const type = slotType(slot.type);
  const TypeIcon = SLOT_TYPE_ICON[type];
  const categoryLabel = t(`month.category.${category}`);
  const typeLabel = t(`month.type.${type}`);
  // BR-CAL-003: службовий запис без наряду й клієнта — назва типу й примітка, щоб блок не був
  // порожнім (механіку примітка не приходить — лише назва).
  const service = isServiceSlotType(type) && !slot.workOrderNumber;
  const titleTooltip = [
    timeLabel,
    slot.workOrderNumber ? `· ${slot.workOrderNumber}` : null,
    slot.workOrderStatus ? woStatusLabel(slot.workOrderStatus) : null,
    slot.employeeName ? t('day.mechanic', { name: slot.employeeName }) : null,
    slot.counterpartyName ?? null,
    slot.cpPhone ?? null,
    slot.vehicleSummary ?? null,
    slot.vehiclePlate ?? null,
    service ? (slot.notes ?? null) : null,
    `${typeLabel} · ${categoryLabel}`,
    canManage && lockedStatus ? lockedHint(lockedStatus) : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-calendar-slot
      data-category={category}
      data-time-locked={lockedStatus ? true : undefined}
      data-editing={isEditing || undefined}
      // Світлий фон і смуга категорії, темний текст (BR-CAL-011). Блок, що редагується, —
      // бурштинова рамка: amber-600 — 3,2:1 до білого, 5,6:1 до темного фону (WCAG 1.4.11).
      className={`absolute top-1 bottom-1 rounded border border-border border-l-4 ${barClassName} ${bgClassName} text-foreground text-xs overflow-hidden group select-none ring-offset-1 ring-offset-surface flex flex-col ${isEditing ? 'ring-2 ring-amber-600 shadow-md' : ''}`}
      title={titleTooltip}
    >
      {movable && (
        <div
          className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-foreground/10 rounded-l flex items-center justify-center"
          onPointerDown={e => {
            e.stopPropagation();
            onResizeStart(e, slot.id, 'start');
          }}
          aria-label={t('day.editStart')}
          data-part="resize-start"
        >
          <div className="w-0.5 h-4 bg-foreground/30 rounded" />
        </div>
      )}

      <div
        className={`@container flex-1 flex flex-col px-3 min-w-0 py-1 relative ${movable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
        data-part="content"
        {...contentProps}
        onClick={() => onEdit(slot)}
      >
        {/* Верхній рядок: тип запису, час, продовження; справа — іконка категорії. У вузькому
            блоці (30 хв на 1280) лишається лише іконка категорії — інакше її обрізало, і
            «чернетку» від «без наряду» (той самий фон) не відрізнити (Bug #876). Час і тип —
            у підказці й для читача екрана. */}
        <span className="flex items-center gap-1 text-[10px] leading-none mb-1 tabular-nums">
          <TypeIcon
            className="h-3 w-3 shrink-0 @max-[2.75rem]:hidden"
            aria-hidden="true"
            data-part="type-icon"
          />
          <span className="truncate @max-[2.75rem]:sr-only" data-part="time">
            {timeLabel}
          </span>
          {slot.parentSlotId && (
            <span className="@max-[2.75rem]:hidden" aria-hidden="true">
              ↩
            </span>
          )}
          <CategoryIcon
            className={`ml-auto h-3.5 w-3.5 shrink-0 ${categoryIconColor}`}
            aria-hidden="true"
          />
        </span>
        <span className="sr-only">{` ${typeLabel}. ${categoryLabel}. `}</span>
        {canManage && lockedStatus && (
          <span className="sr-only">{`${lockedHint(lockedStatus)}. `}</span>
        )}
        {/* Main info — centered */}
        <div className="flex-1 flex flex-col justify-center gap-0.5 min-w-0">
          {service && (
            // Читач екрана чує тип у тексті вище — тут лише видима назва.
            <span
              className="font-bold truncate leading-tight"
              data-part="service-type"
              aria-hidden="true"
            >
              {typeLabel}
            </span>
          )}
          {service && slot.notes && (
            <span className="truncate leading-tight" data-part="notes">
              {slot.notes}
            </span>
          )}
          {slot.workOrderNumber && (
            <span className="font-bold truncate leading-tight">{slot.workOrderNumber}</span>
          )}
          {slot.workOrderStatus && (
            <span className="truncate leading-tight text-[10px]">
              {woStatusLabel(slot.workOrderStatus)}
            </span>
          )}
          {slot.employeeName && (
            <span className="flex items-center gap-1 min-w-0 leading-tight" data-part="mechanic">
              <UserRound className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="sr-only">{`${t('day.mechanicSr')} `}</span>
              <span className="truncate">{slot.employeeName}</span>
            </span>
          )}
          {slot.counterpartyName && (
            <span className="truncate leading-tight">{slot.counterpartyName}</span>
          )}
          {slot.cpPhone && <span className="truncate leading-tight">{slot.cpPhone}</span>}
          {slot.vehicleSummary && (
            <span className="truncate leading-tight">{slot.vehicleSummary}</span>
          )}
          {slot.vehiclePlate && <span className="truncate leading-tight">{slot.vehiclePlate}</span>}
        </div>
      </div>

      {movable && (
        <div
          className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-foreground/10 rounded-r flex items-center justify-center"
          onPointerDown={e => {
            e.stopPropagation();
            onResizeStart(e, slot.id, 'end');
          }}
          aria-label={t('day.editEnd')}
          data-part="resize-end"
        >
          <div className="w-0.5 h-4 bg-foreground/30 rounded" />
        </div>
      )}
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
  const { t } = useTranslation('calendar');
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
      className="absolute top-1 bottom-1 bg-primary/20 border-2 border-primary rounded flex items-center overflow-hidden group select-none z-10 cursor-grab active:cursor-grabbing"
      style={style}
      title={t('day.pendingTooltip')}
      // Тягнути за будь-яку точку картки, а не лише за текст часу. Ручки й «скасувати» зупиняють
      // pointerdown самі; клік без руху (distance 5 у PointerSensor) лишається кліком. `attributes`
      // (role="button") — на тексті: на картці вони обгорнули б кнопку «скасувати» (nested-interactive).
      {...listeners}
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-primary/20 rounded-l flex items-center justify-center"
        onPointerDown={e => {
          e.stopPropagation();
          onPendingResizeStart(e, 'start');
        }}
        aria-label={t('day.editStart')}
      >
        <div className="w-0.5 h-4 bg-primary/60 rounded" />
      </div>

      <span
        className="flex-1 text-xs text-primary font-medium px-3 truncate"
        onClick={onOpen}
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
        aria-label={t('day.cancel')}
      >
        <Plus className="h-3 w-3 rotate-45" />
      </button>

      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-primary/20 rounded-r flex items-center justify-center"
        onPointerDown={e => {
          e.stopPropagation();
          onPendingResizeStart(e, 'end');
        }}
        aria-label={t('day.editEnd')}
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
  const { t } = useTranslation('calendar');
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
      title={`${t('booking.onlineTooltip', { name: slot.clientName, phone: slot.clientPhone })}\n${timeLabel}`}
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
      {unassignedSlots.length > 0 && (
        <div className="mt-6 bg-surface border border-border rounded-xl p-5">
          <h3 className="font-semibold text-foreground mb-3 text-sm">{t('day.unassignedTitle')}</h3>
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
                    <span className="ml-2 text-xs text-primary">
                      {t('day.woPrefix', { number: s.workOrderNumber })}
                    </span>
                  )}
                  {s.counterpartyName && (
                    <span className="ml-2 text-xs text-muted-foreground">{s.counterpartyName}</span>
                  )}
                  {s.notes && <span className="ml-2 text-xs text-muted-foreground">{s.notes}</span>}
                </div>
                {canManageSlots && (
                  <UnassignedSlotDeleteButton slot={s} onRemove={id => void removeSlot(id)} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Кошик запису в переліку «Без підйомника». BR-WO-026 (рішення власника 2026-10-19): запис наряду
 * не в редагованому статусі не видаляється — кнопка недоступна, причина в `title` обгортки
 * (вимкнена кнопка подій миші не отримує) і описом для читача екрана; назва кнопки лишає час
 * запису, щоб кілька заблокованих кошиків не звучали однаково.
 */
function UnassignedSlotDeleteButton({
  slot,
  onRemove,
}: {
  slot: CalendarSlot;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation('calendar');
  const hintId = useId();
  const lockHint = slotDeleteLockHint(t, workOrderTimeLock(slot));
  return (
    <span title={lockHint ?? t('day.deleteSlotTitle')} className="inline-flex">
      {lockHint && (
        <span id={hintId} className="sr-only">
          {lockHint}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={lockHint !== null}
        onClick={() => onRemove(slot.id)}
        aria-label={t('day.deleteSlotAria', {
          time: `${fmtTime(slot.startAt)}–${fmtTime(slot.endAt)}`,
        })}
        aria-describedby={lockHint ? hintId : undefined}
      >
        <Trash2 className="h-3.5 w-3.5 text-destructive" />
      </Button>
    </span>
  );
}
