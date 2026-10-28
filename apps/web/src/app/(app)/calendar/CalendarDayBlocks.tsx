'use client';

import {
  memo,
  useId,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Plus, UserRound } from 'lucide-react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

import { Button } from '@/components/ui/button';
import { woStatusLabel } from '@/i18n/enumLabel';

import type { BookingSlot, CalendarSlot, PendingSlot } from './calendar.types';
import { decimalHoursToHHMM, fmtTime, kyivHours } from './calendar.utils';
import {
  CATEGORY_VIEW,
  SLOT_TYPE_ICON,
  isServiceSlotType,
  slotType,
  type SlotCategory,
} from './calendar-categories';
import { isCancelledWorkOrderSlot, slotDeleteLockHint, workOrderTimeLock } from './calendar-day';
import { PENDING_DRAG_ID } from './useCalendarState';

/** Найменша видима довжина блоку запису, год — крок сітки 15 хв. */
const MIN_BLOCK_H = 0.25;

/**
 * Вісь часу блоку (BR-CAL-014): у планувальнику час іде вздовж рядка (`left`/`width`), у повернутій
 * сітці — вздовж колонки (`top`/`height`). Решта розмітки блоку однакова.
 */
export function axisPos(vertical: boolean, startPct: number, sizePct: number): CSSProperties {
  return vertical
    ? { top: `${startPct}%`, height: `${sizePct}%` }
    : { left: `${startPct}%`, width: `${sizePct}%` };
}

/** Відступ блоку поперек осі часу: у рядку — зверху й знизу, у колонці — ліворуч і праворуч. */
const crossInset = (vertical: boolean) => (vertical ? 'left-1 right-1' : 'top-1 bottom-1');

/** Ручка зміни межі запису: початок — зліва / зверху, кінець — справа / знизу. */
function handleClass(vertical: boolean, edge: 'start' | 'end', hover: string): string {
  const pos = vertical
    ? `left-0 right-0 h-2 cursor-row-resize ${edge === 'start' ? 'top-0 rounded-t' : 'bottom-0 rounded-b'}`
    : `top-0 bottom-0 w-2 cursor-col-resize ${edge === 'start' ? 'left-0 rounded-l' : 'right-0 rounded-r'}`;
  return `absolute ${pos} z-20 ${hover} flex items-center justify-center`;
}

const gripClass = (vertical: boolean) => (vertical ? 'h-0.5 w-4' : 'w-0.5 h-4');

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
  /** Повернута сітка: час — по вертикалі (BR-CAL-014). */
  vertical?: boolean;
  onEdit: (slot: CalendarSlot) => void;
  onResizeStart: (
    e: ReactPointerEvent<HTMLDivElement>,
    slotId: string,
    edge: 'start' | 'end',
  ) => void;
}

export const DraggableSlot = memo(function DraggableSlot({
  slot,
  category,
  isEditing,
  canManage,
  windowStart,
  totalHours,
  vertical = false,
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
    ...axisPos(vertical, left, width),
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
      className={`absolute ${crossInset(vertical)} rounded border border-border border-l-4 ${barClassName} ${bgClassName} text-foreground text-xs overflow-hidden group select-none ring-offset-1 ring-offset-surface flex flex-col ${isEditing ? 'ring-2 ring-amber-600 shadow-md' : ''}`}
      title={titleTooltip}
    >
      {movable && (
        <div
          className={handleClass(vertical, 'start', 'hover:bg-foreground/10')}
          onPointerDown={e => {
            e.stopPropagation();
            onResizeStart(e, slot.id, 'start');
          }}
          aria-label={t('day.editStart')}
          data-part="resize-start"
        >
          <div className={`${gripClass(vertical)} bg-foreground/30 rounded`} />
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
          className={handleClass(vertical, 'end', 'hover:bg-foreground/10')}
          onPointerDown={e => {
            e.stopPropagation();
            onResizeStart(e, slot.id, 'end');
          }}
          aria-label={t('day.editEnd')}
          data-part="resize-end"
        >
          <div className={`${gripClass(vertical)} bg-foreground/30 rounded`} />
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
  vertical?: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onPendingResizeStart: (e: ReactPointerEvent<HTMLDivElement>, edge: 'start' | 'end') => void;
}

export const PendingSlotBlock = memo(function PendingSlotBlock({
  pending,
  windowStart,
  totalHours,
  vertical = false,
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
    ...axisPos(vertical, left, width),
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : 10,
  };

  return (
    <div
      ref={setNodeRef}
      data-pending-slot
      className={`absolute ${crossInset(vertical)} bg-primary/20 border-2 border-primary rounded flex ${vertical ? 'items-start pt-2' : 'items-center'} overflow-hidden group select-none z-10 cursor-grab active:cursor-grabbing`}
      style={style}
      title={t('day.pendingTooltip')}
      // Тягнути за будь-яку точку картки, а не лише за текст часу. Ручки й «скасувати» зупиняють
      // pointerdown самі; клік без руху (distance 5 у PointerSensor) лишається кліком. `attributes`
      // (role="button") — на тексті: на картці вони обгорнули б кнопку «скасувати» (nested-interactive).
      {...listeners}
    >
      <div
        className={handleClass(vertical, 'start', 'hover:bg-primary/20')}
        onPointerDown={e => {
          e.stopPropagation();
          onPendingResizeStart(e, 'start');
        }}
        aria-label={t('day.editStart')}
      >
        <div className={`${gripClass(vertical)} bg-primary/60 rounded`} />
      </div>

      <span
        className="flex-1 text-xs text-primary font-medium px-3 truncate"
        onClick={onOpen}
        // `attributes` роблять текст «кнопкою» (role="button", tabIndex 0), а сенсор лише
        // вказівний — без власного onKeyDown Enter і пробіл нічого не відкривали (клас Bug #877).
        onKeyDown={(e: ReactKeyboardEvent<HTMLSpanElement>) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          onOpen();
        }}
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
        className={handleClass(vertical, 'end', 'hover:bg-primary/20')}
        onPointerDown={e => {
          e.stopPropagation();
          onPendingResizeStart(e, 'end');
        }}
        aria-label={t('day.editEnd')}
      >
        <div className={`${gripClass(vertical)} bg-primary/60 rounded`} />
      </div>
    </div>
  );
});

// ─── BookingSlotBlock ────────────────────────────────────────────────────────

export const BookingSlotBlock = memo(function BookingSlotBlock({
  slot,
  windowStart,
  windowEnd,
  totalHours,
  vertical = false,
}: {
  slot: BookingSlot;
  windowStart: number;
  windowEnd: number;
  totalHours: number;
  vertical?: boolean;
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
      className={`absolute ${crossInset(vertical)} rounded border-2 border-dashed border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 text-xs overflow-hidden flex flex-col px-2 py-1 z-10 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors`}
      style={axisPos(vertical, left, width)}
    >
      <span className="text-[10px] leading-none opacity-75 mb-0.5">{timeLabel}</span>
      <span className="font-medium truncate leading-tight">{slot.clientName}</span>
      <span className="truncate leading-tight opacity-75">{slot.clientPhone}</span>
    </a>
  );
});

/**
 * Записи дня без підйомника — перелік під сіткою (обидві сітки «Дня» показують його однаково).
 */
export function UnassignedSlots({
  slots,
  canManage,
  onRemove,
}: {
  slots: readonly CalendarSlot[];
  canManage: boolean;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation('calendar');
  if (slots.length === 0) return null;
  return (
    <div className="mt-6 bg-surface border border-border rounded-xl p-5">
      <h3 className="font-semibold text-foreground mb-3 text-sm">{t('day.unassignedTitle')}</h3>
      <div className="space-y-2">
        {slots.map(s => (
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
            {canManage && <UnassignedSlotDeleteButton slot={s} onRemove={onRemove} />}
          </div>
        ))}
      </div>
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
