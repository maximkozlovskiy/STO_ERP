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

function buildParams(filters: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [key, val] of Object.entries(filters)) {
    if (val === null || val === undefined || val === '' || val === false) continue;
    if (Array.isArray(val)) val.forEach(v => p.append(key, String(v)));
    else p.set(key, String(val));
  }
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

export function usePaginatedList<T>(
  endpoint: string,
  filters: Record<string, unknown>,
  options?: { staleTime?: number; queryKey?: string },
) {
  const { employee } = useAuth();
  const qs = buildParams(filters);
  const key = options?.queryKey ?? endpoint;
  return useQuery<PaginatedResponse<T>>({
    queryKey: [key, filters],
    queryFn: ({ signal }) => apiFetch(`${endpoint}${qs}`, { signal }),
    enabled: !!employee,
    staleTime: options?.staleTime ?? 30_000,
    placeholderData: keepPreviousData,
  });
}
