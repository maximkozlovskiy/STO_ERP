import { TASK_STATUS_TRANSITIONS, canTransitionTask, isTaskManagerRole } from '@sto/shared';
import type { TaskStatus } from '@/hooks/api/useTasks';
import { taskStatusLabel } from '@/i18n/enumLabel';
import { toast } from '@/lib/toast';

/** Дія переходу статусу задачі — кнопка в картці, рядку списку й планшеті (BR-TASK-003). */
export interface TaskAction {
  to: TaskStatus;
  /** Ключ підпису в просторі `tasks` (`action.*`). */
  labelKey: 'action.start' | 'action.reopen' | 'action.done' | 'action.cancel';
}

/**
 * Переходи, доступні користувачу для задачі: карта `TASK_STATUS_TRANSITIONS` + хто може
 * (`canTransitionTask` — та сама функція, що на сервері). Виконавець своєї задачі — «Взяти в
 * роботу» й «Виконано»; керівник — ще «Скасувати» і «Повернути в роботу».
 */
export function taskActions(
  task: { status: string; assigneeId: string },
  actor: { id: string; role: string } | null | undefined,
): TaskAction[] {
  if (!actor) return [];
  const opts = {
    isManager: isTaskManagerRole(actor.role),
    isAssignee: task.assigneeId === actor.id,
  };
  return (TASK_STATUS_TRANSITIONS[task.status] ?? [])
    .filter(to => canTransitionTask(task.status, to, opts))
    .map(to => ({
      to: to as TaskStatus,
      labelKey:
        to === 'DONE'
          ? 'action.done'
          : to === 'CANCELLED'
            ? 'action.cancel'
            : task.status === 'DONE'
              ? 'action.reopen'
              : 'action.start',
    }));
}

/**
 * Перехід статусу з тостом результату — кнопки рядка списку й картки задачі. Мутацію (і її
 * `isPending` для кнопок) тримає компонент; тут — лише виклик і повідомлення.
 */
export async function runTaskTransition(
  mutateAsync: (v: { id: string; status: TaskStatus }) => Promise<{ status: string }>,
  id: string,
  to: TaskStatus,
  t: (key: string, opts?: Record<string, unknown>) => string,
): Promise<boolean> {
  try {
    const next = await mutateAsync({ id, status: to });
    toast.success(t('toast.status', { status: taskStatusLabel(next.status) }));
    return true;
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : t('form.loadError'));
    return false;
  }
}
