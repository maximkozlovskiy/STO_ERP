import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

// ─── Типи дзеркалять backend report-builder ─────────────────────────────────────

export type Agg = 'SUM' | 'COUNT' | 'AVG' | 'MIN' | 'MAX';
export type FilterOp = 'eq' | 'ne' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'isNull';
export type FieldType = 'scalar' | 'number' | 'decimal' | 'enum' | 'date' | 'boolean';

export interface MetaField {
  key: string;
  label: string;
  type: FieldType;
  enumName?: string;
  aggregations: Agg[];
  filterable: boolean;
  groupable: boolean;
}
export interface MetaEntity {
  key: string;
  label: string;
  dateField: string;
  fields: MetaField[];
  relations: { key: string; label: string; advanced: boolean }[];
}
export interface ReportMetadata {
  entities: MetaEntity[];
  enums: Record<string, string[]>;
}

export interface ReportFilter {
  field: string;
  op: FilterOp;
  value?: unknown;
}
export interface ReportSort {
  field: string;
  dir: 'asc' | 'desc';
}
export interface ReportAgg {
  field: string;
  agg: Agg;
}
export interface ReportConfig {
  entity: string;
  columns: string[];
  groupBy: string[];
  filters?: ReportFilter[];
  sort?: ReportSort[];
  aggregations?: ReportAgg[];
  dateRange?: { from: string; to: string };
  includeRows?: boolean;
}

export interface GroupNode {
  key: string;
  field: string;
  label: string;
  value: unknown;
  count: number;
  aggregates: Record<string, number | null>;
  children: GroupNode[];
  rows?: Record<string, unknown>[];
}
export interface ReportRunResult {
  entity: string;
  columns: { key: string; label: string; type: string }[];
  groupBy: string[];
  result: {
    tree: GroupNode[];
    grandTotals: Record<string, number | null>;
    rowCount: number;
    truncated: boolean;
  };
}

export interface SavedReport {
  id: string;
  name: string;
  entity: string;
  config: ReportConfig;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const reportBuilderKeys = {
  all: ['report-builder'] as const,
  metadata: () => [...reportBuilderKeys.all, 'metadata'] as const,
  saved: () => [...reportBuilderKeys.all, 'saved'] as const,
};

/** Каталог сутностей/полів для конструктора (рідко міняється). */
export function useReportMetadata() {
  const { employee } = useAuth();
  return useQuery<ReportMetadata>({
    queryKey: reportBuilderKeys.metadata(),
    queryFn: ({ signal }) => apiFetch('/reports/builder/metadata', { signal }),
    enabled: !!employee,
    staleTime: 60 * 60_000, // година — реєстр статичний
  });
}

/** Виконати ad-hoc звіт. mutateAsync(config) → ReportRunResult. */
export function useRunReport() {
  return useMutation<ReportRunResult, Error, ReportConfig>({
    mutationFn: config =>
      apiFetch('/reports/builder/run', {
        method: 'POST',
        body: JSON.stringify({ config }),
      }),
  });
}

export function useSavedReports() {
  const { employee } = useAuth();
  return useQuery<SavedReport[]>({
    queryKey: reportBuilderKeys.saved(),
    queryFn: ({ signal }) => apiFetch('/reports/builder/saved', { signal }),
    enabled: !!employee,
    staleTime: 30_000,
  });
}

export function useSaveReport() {
  const qc = useQueryClient();
  return useMutation<SavedReport, Error, { name: string; config: ReportConfig }>({
    mutationFn: body =>
      apiFetch('/reports/builder/saved', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: reportBuilderKeys.saved() }),
  });
}

export function useDeleteSavedReport() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: id => apiFetch(`/reports/builder/saved/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: reportBuilderKeys.saved() }),
  });
}

/** Виконати збережений звіт за id (GET /reports/builder/saved/:id/run). */
export function useRunSavedReport() {
  return useMutation<ReportRunResult, Error, string>({
    mutationFn: id => apiFetch(`/reports/builder/saved/${id}/run`),
  });
}
