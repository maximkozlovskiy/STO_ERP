import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiSchema } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';

/** Сповіщення працівнику в системі (BR-AUT-021) — дзвіночок оболонки. */
export type EmployeeNotification = ApiSchema<'EmployeeNotificationResponseDto'>;
export type PaginatedEmployeeNotifications = ApiSchema<'PaginatedEmployeeNotificationsDto'>;

/** Опитування лічильника — як дашборд: раз на 30 с, лише коли вкладка видима. */
export const NOTIFICATIONS_POLL_MS = 30_000;
const LIST_LIMIT = 30;

export const myNotificationsKeys = {
  all: ['my-notifications'] as const,
  unread: () => [...myNotificationsKeys.all, 'unread-count'] as const,
  list: () => [...myNotificationsKeys.all, 'list'] as const,
};

export function useUnreadNotificationsCount(enabled: boolean) {
  return useQuery({
    queryKey: myNotificationsKeys.unread(),
    queryFn: ({ signal }) =>
      apiFetch<ApiSchema<'UnreadCountDto'>>('/notifications/me/unread-count', { signal }),
    enabled,
    refetchInterval: NOTIFICATIONS_POLL_MS,
    staleTime: NOTIFICATIONS_POLL_MS,
  });
}

/** Список — лише поки панель відкрита; кожне відкриття бере свіжий. */
export function useMyNotifications(enabled: boolean) {
  return useQuery({
    queryKey: myNotificationsKeys.list(),
    queryFn: ({ signal }) =>
      apiFetch<PaginatedEmployeeNotifications>(`/notifications/me?limit=${LIST_LIMIT}`, {
        signal,
      }),
    enabled,
    staleTime: 0,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<EmployeeNotification>(`/notifications/me/${id}/read`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: myNotificationsKeys.all }),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<ApiSchema<'ReadAllResultDto'>>('/notifications/me/read-all', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: myNotificationsKeys.all }),
  });
}
