'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

export interface DashboardSummary {
  activeWo: number;
  todayRevenue: number;
  pendingInvoices: number;
  lowStockCount: number;
  timestamp: string;
}

// Replaced SSE (EventSource long-lived connection) with React Query polling.
// SSE required a slow TCP handshake + custom token-in-querystring auth workaround.
// Polling via React Query:
//   - reuses existing queryClient infra (caching, dedup, error handling)
//   - first fetch runs in parallel with other dashboard queries
//   - automatic 30s refresh via refetchInterval
//   - no persistent open connection on the server
export function useDashboardStream() {
  const { employee } = useAuth();

  const { data, isSuccess } = useQuery<DashboardSummary>({
    queryKey: ['dashboard', 'summary'],
    queryFn: ({ signal }) => apiFetch('/dashboard/summary', { signal }),
    enabled: !!employee,
    staleTime: 25_000, // matches backend DASHBOARD_TTL (25s Redis cache)
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  return { data: data ?? null, isLive: isSuccess };
}
