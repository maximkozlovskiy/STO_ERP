import type { WorkOrderStatus } from '@sto/shared';
import type { LucideIcon } from 'lucide-react';
import {
  AlertCircle,
  Car,
  CheckCircle2,
  Circle,
  Clock,
  Coffee,
  Hammer,
  PencilLine,
  Users,
  Wrench,
  XCircle,
} from 'lucide-react';
import type { CategoryInput } from './calendar.types';

// Типи живуть у calendar.types.ts (інакше цикл імпортів types ↔ categories).
export type { CategoryInput, MonthEntry } from './calendar.types';

/**
 * Категорія запису календаря для лічильників дня у виді «Місяць» (BR-CAL-008).
 * Порядок масиву — порядок показу в клітинці.
 */
export const SLOT_CATEGORIES = [
  'overdue',
  'inProgress',
  'planned',
  'draft',
  'done',
  'cancelled',
  'other',
] as const;
export type SlotCategory = (typeof SLOT_CATEGORIES)[number];

// Наряд, що ще не завершено: минулий запис із ним — прострочений.
const OPEN_STATUSES: ReadonlySet<string> = new Set<WorkOrderStatus>([
  'DRAFT',
  'ESTIMATE',
  'APPROVED',
  'IN_PROGRESS',
  'ON_HOLD',
]);

// `Record<WorkOrderStatus, …>`: новий статус наряду без категорії не збереться (tsc).
const STATUS_CATEGORY: Record<WorkOrderStatus, SlotCategory> = {
  DRAFT: 'draft',
  ESTIMATE: 'planned',
  APPROVED: 'planned',
  IN_PROGRESS: 'inProgress',
  ON_HOLD: 'inProgress',
  COMPLETED: 'done',
  INVOICED: 'done',
  PAID: 'done',
  ARCHIVED: 'done',
  CANCELLED: 'cancelled',
};
// Map, а не індекс об'єкта: рядок із сервера звіряється лише з власними ключами
// (`STATUS_CATEGORY['toString']` повернув би функцію замість категорії).
const BY_STATUS = new Map<string, SlotCategory>(Object.entries(STATUS_CATEGORY));

/**
 * `nowMs` = 0 — час ще не відомий (до гідратації): «прострочено» не ставиться нікому,
 * запис потрапляє в категорію свого наряду.
 */
export function slotCategory(entry: CategoryInput, nowMs: number): SlotCategory {
  const status = entry.workOrderStatus;
  if (!status) return 'other';
  if (nowMs > 0 && OPEN_STATUSES.has(status) && entry.endMs < nowMs) return 'overdue';
  return BY_STATUS.get(status) ?? 'other';
}

export function countCategories(
  entries: readonly CategoryInput[],
  nowMs: number,
): Partial<Record<SlotCategory, number>> {
  const counts: Partial<Record<SlotCategory, number>> = {};
  for (const e of entries) {
    const c = slotCategory(e, nowMs);
    counts[c] = (counts[c] ?? 0) + 1;
  }
  return counts;
}

/**
 * `className` — колір значка й тексту (на `bg-surface`, контраст перевірено для лічильників),
 * `barClassName` — колір смуги зліва на картці запису (BR-CAL-009).
 */
export const CATEGORY_VIEW: Record<
  SlotCategory,
  { icon: LucideIcon; className: string; barClassName: string }
> = {
  overdue: {
    icon: AlertCircle,
    className: 'text-destructive-text',
    barClassName: 'border-l-destructive',
  },
  inProgress: { icon: Wrench, className: 'text-warning-text', barClassName: 'border-l-warning' },
  planned: { icon: Clock, className: 'text-info-text', barClassName: 'border-l-info' },
  draft: {
    icon: PencilLine,
    className: 'text-muted-foreground',
    barClassName: 'border-l-muted-foreground',
  },
  done: { icon: CheckCircle2, className: 'text-success-text', barClassName: 'border-l-success' },
  cancelled: { icon: XCircle, className: 'text-muted-foreground', barClassName: 'border-l-border' },
  other: {
    icon: Circle,
    className: 'text-muted-foreground',
    barClassName: 'border-l-muted-foreground',
  },
};

/** Тип запису календаря (`CalendarSlot.type`) — іконка на картці й рядок легенди. */
export const SLOT_TYPES = ['WORK', 'MAINTENANCE', 'BREAK', 'MEETING'] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

export const SLOT_TYPE_ICON: Record<SlotType, LucideIcon> = {
  WORK: Car,
  MAINTENANCE: Hammer,
  BREAK: Coffee,
  MEETING: Users,
};

const KNOWN_TYPES: ReadonlySet<string> = new Set(SLOT_TYPES);
const isSlotType = (type: string): type is SlotType => KNOWN_TYPES.has(type);

/** Тип без значення (старі записи) чи невідомий — робота: UI створює лише WORK-слоти. */
export function slotType(type: string | undefined): SlotType {
  return type && isSlotType(type) ? type : 'WORK';
}
