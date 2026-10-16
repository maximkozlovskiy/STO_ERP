import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { kyivToday } from '@/lib/format';

// kyivWeekStart needs its own formatter; kyivToday is from lib/format
const KYIV_YMD = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });
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
  expiringWarranties: () => ['dashboard-data', 'expiring-warranties'] as const,
};

const OPTS = { staleTime: 60_000, gcTime: 5 * 60_000 } as const;

/**
 * Хто читає списки, з яких дашборд рахує показники, — дзеркало `@Roles` їхніх ендпоінтів (Bug #879;
 * збіг стереже `useDashboardData.roles.test.ts`). Ролі поза списком запиту не шлють: 403 давав банер
 * помилки й порожній дашборд механіку й приймальні. Лічильники всім ролям віддає
 * `GET /dashboard/summary` (`useDashboardStream`).
 */
export const DASHBOARD_READ_ROLES = {
  /** `GET /work-orders` */
  orders: ['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT'],
  /** `GET /stock-items/low` */
  lowStock: ['OWNER', 'ADMIN', 'STOREKEEPER'],
  /** `GET /invoices` */
  invoices: ['OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST'],
  /** `GET /reports/revenue` */
  revenue: ['OWNER', 'ADMIN', 'ACCOUNTANT'],
  /** `GET /maintenance-schedules/upcoming` */
  maintenance: ['OWNER', 'ADMIN', 'RECEPTIONIST'],
  /** `GET /warranties/expiring` */
  expiringWarranties: ['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT'],
} as const satisfies Record<string, readonly string[]>;

export type DashboardAccess = Record<keyof typeof DASHBOARD_READ_ROLES, boolean>;

/** Які списки дашборда роль може читати; без ролі (до входу) — жодного. */
export function dashboardAccess(role: string | null | undefined): DashboardAccess {
  const can = (roles: readonly string[]) => !!role && roles.includes(role);
  return {
    orders: can(DASHBOARD_READ_ROLES.orders),
    lowStock: can(DASHBOARD_READ_ROLES.lowStock),
    invoices: can(DASHBOARD_READ_ROLES.invoices),
    revenue: can(DASHBOARD_READ_ROLES.revenue),
    maintenance: can(DASHBOARD_READ_ROLES.maintenance),
    expiringWarranties: can(DASHBOARD_READ_ROLES.expiringWarranties),
  };
}

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

export function useDashboardExpiringWarranties(enabled: boolean) {
  return useQuery({
    queryKey: dashboardKeys.expiringWarranties(),
    queryFn: ({ signal }) => apiFetch('/warranties/expiring?days=30', { signal }),
    enabled,
    ...OPTS,
  });
}
