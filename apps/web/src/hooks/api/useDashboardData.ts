import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

// Module-level Kyiv date formatters (singleton — no per-call construction)
const KYIV_YMD = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });

function kyivToday() {
  return KYIV_YMD.format(new Date());
}
function kyivWeekStart() {
  return KYIV_YMD.format(new Date(Date.now() - 6 * 86_400_000));
}

export const dashboardKeys = {
  all: ['dashboard-data'] as const,
  orders: () => ['dashboard-data', 'orders'] as const,
  lowStock: () => ['dashboard-data', 'low-stock'] as const,
  invoices: () => ['dashboard-data', 'invoices'] as const,
  revenue: (weekStart: string, today: string) =>
    ['dashboard-data', 'revenue', weekStart, today] as const,
  maintenance: () => ['dashboard-data', 'maintenance'] as const,
};

const OPTS = { staleTime: 60_000, gcTime: 5 * 60_000 } as const;

export function useDashboardOrders(enabled: boolean) {
  return useQuery({
    queryKey: dashboardKeys.orders(),
    queryFn: ({ signal }) => apiFetch('/work-orders?limit=200', { signal }),
    enabled,
    ...OPTS,
  });
}

export function useDashboardLowStock(enabled: boolean) {
  return useQuery({
    queryKey: dashboardKeys.lowStock(),
    queryFn: ({ signal }) => apiFetch('/stock-items/low', { signal }),
    enabled,
    ...OPTS,
  });
}

export function useDashboardInvoices(enabled: boolean) {
  return useQuery({
    queryKey: dashboardKeys.invoices(),
    queryFn: ({ signal }) => apiFetch('/invoices?status=SENT&limit=200', { signal }),
    enabled,
    ...OPTS,
  });
}

export function useDashboardRevenue(enabled: boolean) {
  const today = kyivToday();
  const weekStart = kyivWeekStart();
  return useQuery({
    queryKey: dashboardKeys.revenue(weekStart, today),
    queryFn: ({ signal }) => apiFetch(`/reports/revenue?from=${weekStart}&to=${today}`, { signal }),
    enabled,
    ...OPTS,
  });
}

export function useDashboardMaintenance(enabled: boolean) {
  return useQuery({
    queryKey: dashboardKeys.maintenance(),
    queryFn: ({ signal }) => apiFetch('/maintenance-schedules/upcoming?days=30', { signal }),
    enabled,
    ...OPTS,
  });
}
