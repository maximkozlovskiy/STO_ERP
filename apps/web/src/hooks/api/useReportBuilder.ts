import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import type { ApiSchema } from '@sto/shared';

// ─── Типи ────────────────────────────────────────────────────────────────────────
//
// ВІДПОВІДІ — зі згенерованих схем (зміна на беку ламає компіляцію тут).
// ЗАПИТИ (ReportConfig і його частини) лишаються рукописними: вони вужчі за DTO —
// літеральні union-и (Agg, FilterOp, dir) дають автодоповнення і ловлять одрук у
// конструкторі, чого `string` зі згенерованої схеми не дає.

export type Agg = 'SUM' | 'COUNT' | 'AVG' | 'MIN' | 'MAX';
export type FilterOp = 'eq' | 'ne' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'isNull';
export type FieldType = 'scalar' | 'number' | 'decimal' | 'enum' | 'date' | 'boolean';

export type MetaField = ApiSchema<'ReportMetadataFieldDto'>;
export type MetaEntity = ApiSchema<'ReportMetadataEntityDto'>;
export type ReportMetadata = ApiSchema<'ReportMetadataDto'>;

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
/** Ефективна агрегація з розширеною метаданими (Bug #620): `type`+`label` дозволяють
 * коректно форматувати MIN/MAX-дати і надписи навіть коли поле НЕ у `columns`. */
export interface ReportAggEnriched extends ReportAgg {
  type: string;
  label: string;
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
  sortByAggregate?: { alias: string; dir: 'asc' | 'desc' };
}

export type GroupNode = ApiSchema<'GroupNodeDto'>;
/**
 * Конверт — зі згенерованої схеми; `aggregations` звужено до `ReportAggEnriched`,
 * бо на беку `agg` — `string`, а тут літеральний `Agg` потрібен для форматування
 * (Bug #620: MIN/MAX-дати відрізняються від SUM грошей).
 */
export type ReportRunResult = Omit<ApiSchema<'ReportRunResponseDto'>, 'aggregations'> & {
  aggregations: ReportAggEnriched[];
};

/** Серверний рядок + звужений `config`: бек віддає його як вільний JSON. */
export type SavedReport = Omit<ApiSchema<'SavedReportResponseDto'>, 'config'> & {
  config: ReportConfig;
};

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

/** Перейменувати і/або оновити конфіг збереженого звіту (PATCH /reports/builder/saved/:id). */
export function useUpdateSavedReport() {
  const qc = useQueryClient();
  return useMutation<SavedReport, Error, { id: string; name?: string; config?: ReportConfig }>({
    mutationFn: ({ id, ...body }) =>
      apiFetch(`/reports/builder/saved/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: reportBuilderKeys.saved() }),
  });
}

/** Виконати збережений звіт за id (GET /reports/builder/saved/:id/run). */
export function useRunSavedReport() {
  return useMutation<ReportRunResult, Error, string>({
    mutationFn: id => apiFetch(`/reports/builder/saved/${id}/run`),
  });
}
