import { TASK_STATUS_TRANSITIONS, canTransitionTask, isTaskManagerRole } from '@sto/shared';
import type { TaskStatus } from '@/hooks/api/useTasks';

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
