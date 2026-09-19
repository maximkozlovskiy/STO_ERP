import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';

/** Рядок DLQ — дзеркалить DeadLetterService.findAll() (dead-letter.dto.ts PaginatedDeadLetterDto). */
export interface DeadLetterJob {
  id: string;
  orgId: string | null;
  queueName: string;
  jobName: string;
  bullJobId: string;
  attemptsMade: number;
  maxAttempts: number;
  failedReason: string;
  stacktrace: string | null;
  payload: unknown;
  resolved: boolean;
  resolvedAt: string | null;
  createdAt: string;
}

export interface DeadLetterFilter extends Record<string, unknown> {
  page?: number;
  limit?: number;
  queueName?: string;
  resolved?: string; // 'true' | 'false' | undefined
}

export function useDeadLetter(filters: DeadLetterFilter = {}) {
  return usePaginatedList<DeadLetterJob>('/dead-letter', filters, { queryKey: 'dead-letter' });
}

export type PaginatedDeadLetter = PaginatedResponse<DeadLetterJob>;

export function useResolveDeadLetter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ id: string; resolved: boolean }>(`/dead-letter/${id}/resolve`, {
        method: 'PATCH',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dead-letter'] });
    },
  });
}
