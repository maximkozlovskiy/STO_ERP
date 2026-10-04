import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import type { ApiSchema } from '@sto/shared';

export type ReportTab =
  | 'revenue'
  | 'work-orders'
  | 'stock'
  | 'settlements'
  | 'settlements-detail'
  | 'load'
  | 'profitability'
  | 'vat';

export const reportsKeys = {
  all: ['reports'] as const,
  report: (tab: ReportTab, from: string, to: string) => ['reports', tab, from, to] as const,
};

/**
 * Вкладка → форма відповіді, зі ЗГЕНЕРОВАНИХ схем.
 *
 * Було `Record<string, unknown>` + `as ReportData` у page.tsx — тобто тип відповіді
 * тримався на ручному касті. Відколи у звітів є DTO в OpenAPI-документі, тип можна
 * вивести: зміна форми на беку тепер ламає компіляцію, а не дає тихий `undefined`.
 *
 * `settlements-detail` — UI-only вкладка (запиту не робить, `enabled:false`), тож
 * її відповідь — `never`: спроба прочитати дані для неї не скомпілюється.
 */
export type ReportResponseByTab = {
  revenue: ApiSchema<'RevenueReportDto'>;
  'work-orders': ApiSchema<'WorkOrdersReportDto'>;
  stock: ApiSchema<'StockReportDto'>;
  settlements: ApiSchema<'SettlementsReportDto'>;
  'settlements-detail': never;
  load: ApiSchema<'LoadReportDto'>;
  profitability: ApiSchema<'ProfitabilityReportDto'>;
  vat: ApiSchema<'VatReportDto'>;
};

export function useReport<T extends ReportTab>(tab: T, from: string, to: string) {
  const { employee } = useAuth();
  return useQuery<ReportResponseByTab[T]>({
    queryKey: reportsKeys.report(tab, from, to),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ from, to });
      return apiFetch(`/reports/${tab}?${params}`, { signal });
    },
    // enabled тільки якщо є дати, employee, і це звітна вкладка (не UI-only settlements-detail)
    enabled: !!employee && !!from && !!to && tab !== 'settlements-detail',
    staleTime: 5 * 60_000, // звіти рідко міняються під час перегляду
    gcTime: 10 * 60_000,
    // При зміні from/to/tab — лишаємо попередній звіт видимим поки новий
    // завантажується (інакше графік/таблиця мерехтить на 300-500мс).
    placeholderData: keepPreviousData,
  });
}

export function useInvalidateReports() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: reportsKeys.all });
}
