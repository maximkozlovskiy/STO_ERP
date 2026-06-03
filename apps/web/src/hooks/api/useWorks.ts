'use client';

import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

export interface Work {
  id: string;
  name: string;
  categoryId: string | null;
  categoryName?: string | null;
  normoHours: number;
  price: number;
  description?: string | null;
  isWarranty?: boolean;
  deletedAt?: string | null;
}

export interface WorksFilter {
  page?: number;
  limit?: number;
  categoryId?: string;
  categoryIds?: string[];
  q?: string;
  showDeleted?: boolean;
}

export interface PaginatedWorks {
  items: Work[];
  total: number;
  page: number;
  limit: number;
}

export const worksKeys = {
  all: ['works'] as const,
  lists: () => [...worksKeys.all, 'list'] as const,
  list: (filters: WorksFilter) => [...worksKeys.lists(), filters] as const,
};

export function useWorks(filters: WorksFilter = {}) {
  const { employee } = useAuth();
  const params = new URLSearchParams({
    page: String(filters.page ?? 1),
    limit: String(filters.limit ?? 50),
  });
  if (filters.categoryIds?.length)
    filters.categoryIds.forEach(id => params.append('categoryIds', id));
  else if (filters.categoryId) params.set('categoryId', filters.categoryId);
  if (filters.q) params.set('q', filters.q);
  if (filters.showDeleted) params.set('showDeleted', 'true');

  return useQuery<PaginatedWorks>({
    queryKey: worksKeys.list(filters),
    queryFn: ({ signal }) => apiFetch(`/works?${params}`, { signal }),
    enabled: !!employee,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useInvalidateWorks() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: worksKeys.all });
}
