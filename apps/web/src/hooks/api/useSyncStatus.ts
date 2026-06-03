'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

export interface SyncStatus {
  pendingJobs: number;
  failedJobs: number;
  lastSyncAt: string | null;
  maxSyncVersion: number;
}

export const syncKeys = {
  all: ['sync'] as const,
  status: () => ['sync', 'status'] as const,
};

export function useSyncStatus() {
  const { employee } = useAuth();
  return useQuery<SyncStatus>({
    queryKey: syncKeys.status(),
    queryFn: ({ signal }) => apiFetch('/sync/status', { signal }),
    enabled: !!employee,
    staleTime: 30_000,
    refetchInterval: 60_000, // автооновлення кожну хвилину
  });
}

export function useInvalidateSyncStatus() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: syncKeys.all });
}
