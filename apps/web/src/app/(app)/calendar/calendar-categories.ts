import type { LucideIcon } from 'lucide-react';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Clock,
  PencilLine,
  Wrench,
  XCircle,
} from 'lucide-react';

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

/** Мінімум даних запису, потрібний для категорії (місяць не тримає слоти цілком). */
export interface MonthEntry {
  endMs: number;
  workOrderStatus: string | null;
}

// Наряд, що ще не завершено: минулий запис із ним — прострочений.
const OPEN_STATUSES = new Set(['DRAFT', 'ESTIMATE', 'APPROVED', 'IN_PROGRESS', 'ON_HOLD']);

const BY_STATUS: Record<string, SlotCategory> = {
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

export function slotCategory(entry: MonthEntry, nowMs: number): SlotCategory {
  const status = entry.workOrderStatus;
  if (!status) return 'other';
  if (OPEN_STATUSES.has(status) && entry.endMs < nowMs) return 'overdue';
  return BY_STATUS[status] ?? 'other';
}

export function countCategories(
  entries: readonly MonthEntry[],
  nowMs: number,
): Partial<Record<SlotCategory, number>> {
  const counts: Partial<Record<SlotCategory, number>> = {};
  for (const e of entries) {
    const c = slotCategory(e, nowMs);
    counts[c] = (counts[c] ?? 0) + 1;
  }
  return counts;
}

export const CATEGORY_VIEW: Record<SlotCategory, { icon: LucideIcon; className: string }> = {
  overdue: { icon: AlertCircle, className: 'text-destructive-text' },
  inProgress: { icon: Wrench, className: 'text-warning-text' },
  planned: { icon: Clock, className: 'text-info-text' },
  draft: { icon: PencilLine, className: 'text-muted-foreground' },
  done: { icon: CheckCircle2, className: 'text-success-text' },
  cancelled: { icon: XCircle, className: 'text-muted-foreground' },
  other: { icon: Circle, className: 'text-muted-foreground' },
};
