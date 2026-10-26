import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isTaskManagerRole, type ApiSchema, type TaskFormValues } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { invalidateTaskAffected } from '@/lib/cache-invalidation';
import { employeesKeys, type PaginatedEmployees } from '@/hooks/api/useEmployees';

/** Задача співробітнику (docs/objects/task.md) — форма відповіді API. */
export type Task = ApiSchema<'TaskResponseDto'>;
export type PaginatedTasks = ApiSchema<'PaginatedTasksDto'>;
export type TaskStatus = Task['status'];
export type TaskPriority = Task['priority'];

export const TASK_STATUSES: readonly TaskStatus[] = ['NEW', 'IN_PROGRESS', 'DONE', 'CANCELLED'];
export const TASK_PRIORITIES: readonly TaskPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

export interface TaskListFilters {
  page: number;
  limit: number;
  q?: string;
  statuses?: readonly TaskStatus[];
  priorities?: readonly TaskPriority[];
  assigneeId?: string;
  /** Лише задачі, де я виконавець (BR-TASK-002 — у керівника звужує, у виконавця й так так). */
  mine?: boolean;
  /** Лише прострочені (BR-TASK-005). */
  overdue?: boolean;
  /** Дні за Києвом `YYYY-MM-DD` включно: задачі, чий проміжок їх перетинає (BR-TASK-004). */
  from?: string;
  to?: string;
  /** Список (не календар): + відкриті без дат і з датами до `from` (BR-TASK-009). */
  includeOpen?: boolean;
  workOrderId?: string;
  sortBy?: 'dueAt' | 'startAt' | 'priority' | 'createdAt' | 'completedAt';
  sortDir?: 'asc' | 'desc';
}

export const tasksKeys = {
  all: ['tasks'] as const,
  lists: () => [...tasksKeys.all, 'list'] as const,
  list: (f: TaskListFilters) => [...tasksKeys.lists(), f] as const,
  detail: (id: string) => [...tasksKeys.all, 'detail', id] as const,
};

export function taskListPath(f: TaskListFilters): string {
  const params = new URLSearchParams({ page: String(f.page), limit: String(f.limit) });
  if (f.q) params.set('q', f.q);
  if (f.statuses?.length) params.set('status', f.statuses.join(','));
  if (f.priorities?.length) params.set('priority', f.priorities.join(','));
  if (f.assigneeId) params.set('assigneeId', f.assigneeId);
  if (f.mine) params.set('mine', 'true');
  if (f.overdue) params.set('overdue', 'true');
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);
  if (f.includeOpen) params.set('includeOpen', 'true');
  if (f.workOrderId) params.set('workOrderId', f.workOrderId);
  if (f.sortBy) params.set('sortBy', f.sortBy);
  if (f.sortDir) params.set('sortDir', f.sortDir);
  return `/tasks?${params}`;
}

export function useTaskList(filters: TaskListFilters, enabled = true) {
  return useQuery({
    queryKey: tasksKeys.list(filters),
    queryFn: ({ signal }) => apiFetch<PaginatedTasks>(taskListPath(filters), { signal }),
    enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/** Картка задачі: свіжа з сервера при кожному відкритті (статус міг змінити інший працівник). */
export function useTask(id: string | null, enabled = true) {
  return useQuery({
    queryKey: tasksKeys.detail(id ?? ''),
    queryFn: ({ signal }) => apiFetch<Task>(`/tasks/${id}`, { signal }),
    enabled: enabled && !!id,
    staleTime: 0,
  });
}

/**
 * Активні працівники для поля «Виконавець» (BR-TASK-001). `GET /employees` — лише ролям
 * керування (форма задачі редагується лише ними); список у кеші співробітників, тож нова
 * картка працівника його скидає.
 */
export function useTaskAssignees(role: string | null | undefined) {
  const filters = { limit: 200, sortBy: 'lastName', sortDir: 'asc' as const };
  return useQuery({
    queryKey: employeesKeys.list(filters),
    queryFn: ({ signal }) =>
      apiFetch<PaginatedEmployees>('/employees?limit=200&sortBy=lastName&sortDir=asc', { signal }),
    enabled: isTaskManagerRole(role),
    staleTime: 60_000,
  });
}

/** Тіло POST / PATCH — повна форма (`taskFormSchema`); дати — ISO з поясом. */
export type TaskBody = Omit<TaskFormValues, 'priority'> & { priority?: TaskPriority };

export function useSaveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: TaskBody }) =>
      apiFetch<Task>(id ? `/tasks/${id}` : '/tasks', {
        method: id ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateTaskAffected(qc),
  });
}

export function useTransitionTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: TaskStatus }) =>
      apiFetch<Task>(`/tasks/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => invalidateTaskAffected(qc),
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/tasks/${id}`, { method: 'DELETE' }),
    onSuccess: (_res, id) => invalidateTaskAffected(qc, id),
  });
}
