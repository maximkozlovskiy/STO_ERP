/**
 * Кольорові індикатори стану рядка списку (ліва вертикальна смужка).
 *
 * Чиста, enum-агностична функція: кожен список нормалізує свій запис до
 * дескриптора { dueDate, active, balanceDue } і отримує «тон», який мапиться
 * на клас лівої рамки. Логіка живе в ОДНОМУ місці — списки лише постачають дані.
 *
 * Пріоритет тонів (від найтермінового):
 *   overdue  — прострочений дедлайн у активному документі (потребує уваги)
 *   today    — дедлайн сьогодні у активному документі
 *   debt     — є непогашений залишок (borg) у виставленому/завершеному документі
 *   none     — нічого не підсвічуємо
 *
 * `active` = документ ще «живий» (не термінальний: не скасований/архівний/оплачений).
 * Для термінальних документів дедлайн уже не «горить» — рамку не малюємо.
 */
export type RowStatusTone = 'overdue' | 'today' | 'debt' | 'none';

export interface RowStatusInput {
  /** ISO-дата дедлайну (напр. dueDate). null/undefined → без дедлайн-логіки. */
  dueDate?: string | null;
  /** Документ ще активний (не термінальний). Для термінальних дедлайн не «горить». */
  active?: boolean;
  /** Непогашений залишок у копійках/гривнях (>0 → борг). */
  balanceDue?: number | null;
}

/** Чи припадає ISO-дата на «сьогодні» за локальним днем користувача (Europe/Kyiv у рантаймі). */
function isDueToday(dueDateIso: string, nowMs: number): boolean {
  const due = new Date(dueDateIso);
  const now = new Date(nowMs);
  return (
    due.getFullYear() === now.getFullYear() &&
    due.getMonth() === now.getMonth() &&
    due.getDate() === now.getDate()
  );
}

/**
 * Чи прострочений дедлайн: кінець дня дедлайну вже позаду.
 * Дзеркалить isOverdue() зі списку нарядів (due.setHours(23,59,59,999) < now).
 */
function isPastDue(dueDateIso: string, nowMs: number): boolean {
  const due = new Date(dueDateIso);
  due.setHours(23, 59, 59, 999);
  return due.getTime() < nowMs;
}

export function rowStatusTone(input: RowStatusInput, nowMs: number): RowStatusTone {
  const active = input.active ?? true;

  if (active && input.dueDate) {
    if (isPastDue(input.dueDate, nowMs)) return 'overdue';
    if (isDueToday(input.dueDate, nowMs)) return 'today';
  }

  if ((input.balanceDue ?? 0) > 0.005) return 'debt';

  return 'none';
}

/**
 * Клас лівої рамки-рубчика для тону. Порожній рядок для 'none' —
 * рядок лишається без рамки й не «стрибає» по ширині (border-l-2 transparent
 * зберігає вирівнювання, коли частина рядків підсвічена).
 */
export function rowStatusBorderClass(tone: RowStatusTone): string {
  switch (tone) {
    case 'overdue':
      return 'border-l-2 border-l-destructive';
    case 'today':
      return 'border-l-2 border-l-warning';
    case 'debt':
      return 'border-l-2 border-l-warning/60';
    case 'none':
      return 'border-l-2 border-l-transparent';
  }
}

/** Людська підказка для тону (title/aria). */
export function rowStatusLabel(tone: RowStatusTone): string | undefined {
  switch (tone) {
    case 'overdue':
      return 'Прострочено';
    case 'today':
      return 'Дедлайн сьогодні';
    case 'debt':
      return 'Є непогашений залишок';
    case 'none':
      return undefined;
  }
}
