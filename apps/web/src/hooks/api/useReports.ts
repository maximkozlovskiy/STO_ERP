import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

export type ReportTab =
  | 'revenue'
  | 'work-orders'
  | 'stock'
  | 'settlements'
  | 'load'
  | 'profitability';

export const reportsKeys = {
  all: ['reports'] as const,
  report: (tab: ReportTab, from: string, to: string) => ['reports', tab, from, to] as const,
};

export function useReport(tab: ReportTab, from: string, to: string) {
  const { employee } = useAuth();
  return useQuery<Record<string, unknown>>({
    queryKey: reportsKeys.report(tab, from, to),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ from, to });
      return apiFetch(`/reports/${tab}?${params}`, { signal });
    },
    // enabled тільки якщо є дати і employee
    enabled: !!employee && !!from && !!to,
    staleTime: 5 * 60_000, // звіти рідко міняються під час перегляду
    gcTime: 10 * 60_000,
  });
}

export function useInvalidateReports() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: reportsKeys.all });
}
