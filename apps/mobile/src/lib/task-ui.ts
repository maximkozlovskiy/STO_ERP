import {
  TASK_STATUS_BADGE,
  TASK_STATUS_LABELS,
  WO_PRIORITY_BADGE,
  WO_PRIORITY_LABELS,
  type BadgeVariant,
} from '@sto/shared';
import type { TaskModel } from '../models/TaskModel';

/** Колір бейджа планшета за варіантом зі `@sto/shared` — ті самі смисли, що й у web. */
const BADGE_COLORS: Record<BadgeVariant, string> = {
  default: '#2563eb',
  secondary: '#6b7280',
  outline: '#6b7280',
  success: '#16a34a',
  warning: '#d97706',
  destructive: '#dc2626',
  info: '#0891b2',
  purple: '#7c3aed',
};

export interface BadgeView {
  label: string;
  color: string;
}

export function taskStatusBadge(status: string): BadgeView {
  const variant = TASK_STATUS_BADGE[status] ?? 'secondary';
  return { label: TASK_STATUS_LABELS[status] ?? status, color: BADGE_COLORS[variant] };
}

export function taskPriorityBadge(priority: string): BadgeView {
  const variant = WO_PRIORITY_BADGE[priority] ?? 'secondary';
  return { label: WO_PRIORITY_LABELS[priority] ?? priority, color: BADGE_COLORS[variant] };
}

/** Підписи кнопок переходів, доступних виконавцю (BR-TASK-003). */
export const TASK_TRANSITION_LABELS: Record<string, string> = {
  IN_PROGRESS: '▶ Взяти в роботу',
  DONE: '✓ Виконано',
};

export const TASK_TRANSITION_COLORS: Record<string, string> = {
  IN_PROGRESS: '#d97706',
  DONE: '#16a34a',
};

/** Знімок рядка WatermelonDB для рендеру: модель мутабельна, React-стану потрібен об'єкт. */
export interface TaskView {
  remoteId: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  startAt: number | null;
  dueAt: number | null;
  completedAt: number | null;
  createdByName: string | null;
  workOrderId: string | null;
  workOrderNumber: string | null;
  workOrderDeleted: boolean;
  vehicleSummary: string | null;
  counterpartyName: string | null;
  isDirty: boolean;
}

export function toTaskView(r: TaskModel): TaskView {
  return {
    remoteId: r.remoteId,
    title: r.title,
    description: r.description,
    status: r.status,
    priority: r.priority,
    startAt: r.startAt,
    dueAt: r.dueAt,
    completedAt: r.completedAt,
    createdByName: r.createdByName,
    workOrderId: r.workOrderId,
    workOrderNumber: r.workOrderNumber,
    workOrderDeleted: r.workOrderDeleted,
    vehicleSummary: r.vehicleSummary,
    counterpartyName: r.counterpartyName,
    isDirty: r.isDirty,
  };
}

/** Прив'язка задачі одним рядком: наряд, авто, клієнт — що є. */
export function taskLinkSummary(t: TaskView): string {
  const parts: string[] = [];
  if (t.workOrderNumber) {
    parts.push(`Наряд ${t.workOrderNumber}${t.workOrderDeleted ? ' (видалений)' : ''}`);
  }
  if (t.vehicleSummary) parts.push(t.vehicleSummary);
  if (t.counterpartyName) parts.push(t.counterpartyName);
  return parts.join(' · ');
}
