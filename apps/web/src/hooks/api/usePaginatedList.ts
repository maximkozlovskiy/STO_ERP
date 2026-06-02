'use client';

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

function buildParams(filters: Record<string, unknown>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [key, val] of Object.entries(filters)) {
    if (val === null || val === undefined || val === '') continue;
    if (Array.isArray(val)) val.forEach(v => p.append(key, String(v)));
    else p.set(key, String(val));
  }
  return p;
}

export function usePaginatedList<T>(
  endpoint: string,
  filters: Record<string, unknown>,
  options?: { staleTime?: number; queryKey?: string },
) {
  const { employee } = useAuth();
  const params = buildParams(filters);
  const key = options?.queryKey ?? endpoint;
  return useQuery<PaginatedResponse<T>>({
    queryKey: [key, filters],
    queryFn: ({ signal }) => apiFetch(`${endpoint}?${params}`, { signal }),
    enabled: !!employee,
    staleTime: options?.staleTime ?? 30_000,
    placeholderData: keepPreviousData,
  });
}
