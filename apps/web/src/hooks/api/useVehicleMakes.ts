import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type { ApiSchema } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { counterpartiesKeys } from '@/hooks/api/useCounterparties';
import { workOrdersKeys } from '@/hooks/api/useWorkOrders';

/** Марка й модель довідника — ЗГЕНЕРОВАНІ типи з OpenAPI (`pnpm gen:api-types`). */
export type VehicleMake = ApiSchema<'VehicleMakeResponseDto'>;
export type VehicleModel = ApiSchema<'VehicleModelResponseDto'>;

/**
 * Ролі довідника марок (BR-VEH-013, `vehicle-makes.controller.ts`): читають усі ролі форми авто;
 * додають і перейменовують — ще й приймальник; видаляють, відновлюють і зливають — власник і адмін.
 */
export const VEHICLE_DIRECTORY_WRITE_ROLES: readonly string[] = ['OWNER', 'ADMIN', 'RECEPTIONIST'];
export const VEHICLE_DIRECTORY_MANAGE_ROLES: readonly string[] = ['OWNER', 'ADMIN'];

export const vehicleMakesKeys = {
  all: ['vehicle-makes'] as const,
  lists: () => [...vehicleMakesKeys.all, 'list'] as const,
  list: (showDeleted: boolean) => [...vehicleMakesKeys.lists(), showDeleted] as const,
  models: (makeId: string) => [...vehicleMakesKeys.all, 'models', makeId] as const,
  modelList: (makeId: string, showDeleted: boolean) =>
    [...vehicleMakesKeys.models(makeId), showDeleted] as const,
};

// Довідник рідко змінюється під час сесії — 5 хв, як інші довідники; кожна мутація нижче скидає
// весь `vehicleMakesKeys.all`. Повернення на вкладку перечитує: модель часто додають в іншій
// вкладці («Контрагенти → Марки авто» з підказки форми) і повертаються до незбереженої форми авто.
const REFERENCE_STALE_MS = 5 * 60_000;

/**
 * `fresh` — вкладка довідника: щоразу при відкритті перечитує список (Bug #957). Її лічильники
 * авто (`vehicleCount`, BR-VEH-009) міняє кожен запис авто — форма, картка контрагента, майстер
 * календаря, планшет; 5 хв кешу форми показали б «0 авто» перед видаленням чи злиттям марки.
 */
interface DirectoryQueryOptions {
  fresh?: boolean;
}

/**
 * Опції запитів довідника — спільні для хуків і для `queryClient.ensureQueryData` (поле вибору
 * марки/моделі чекає на перше завантаження й приєднується до запиту, що вже йде).
 */
export function vehicleMakesQuery(
  showDeleted = false,
  { fresh = false }: DirectoryQueryOptions = {},
) {
  return queryOptions({
    queryKey: vehicleMakesKeys.list(showDeleted),
    queryFn: ({ signal }) =>
      apiFetch<{ items: VehicleMake[]; total: number }>(
        `/vehicle-makes${showDeleted ? '?showDeleted=true' : ''}`,
        { signal },
      ).then(r => r.items),
    staleTime: fresh ? 0 : REFERENCE_STALE_MS,
    refetchOnWindowFocus: true,
  });
}

export function vehicleModelsQuery(
  makeId: string,
  showDeleted = false,
  { fresh = false }: DirectoryQueryOptions = {},
) {
  return queryOptions({
    queryKey: vehicleMakesKeys.modelList(makeId, showDeleted),
    queryFn: ({ signal }) =>
      apiFetch<{ items: VehicleModel[]; total: number }>(
        `/vehicle-makes/${makeId}/models${showDeleted ? '?showDeleted=true' : ''}`,
        { signal },
      ).then(r => r.items),
    staleTime: fresh ? 0 : REFERENCE_STALE_MS,
    refetchOnWindowFocus: true,
  });
}

export function useVehicleMakes(showDeleted = false, options: DirectoryQueryOptions = {}) {
  return useQuery(vehicleMakesQuery(showDeleted, options));
}

export function useVehicleModels(
  makeId: string | null | undefined,
  showDeleted = false,
  options: DirectoryQueryOptions = {},
) {
  return useQuery({ ...vehicleModelsQuery(makeId ?? '', showDeleted, options), enabled: !!makeId });
}

/**
 * Після запису довідника — сам довідник; після перейменування чи злиття ще й те, що показує
 * назву марки авто зі знімка (BR-VEH-011): наряди й контрагенти.
 */
function invalidateDirectory(qc: QueryClient, touchesVehicleNames: boolean): void {
  void qc.invalidateQueries({ queryKey: vehicleMakesKeys.all });
  if (!touchesVehicleNames) return;
  void qc.invalidateQueries({ queryKey: workOrdersKeys.all });
  void qc.invalidateQueries({ queryKey: counterpartiesKeys.all });
}

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export function useCreateVehicleMake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<VehicleMake>('/vehicle-makes', { method: 'POST', ...json({ name }) }),
    onSuccess: () => invalidateDirectory(qc, false),
  });
}

export function useRenameVehicleMake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      apiFetch<VehicleMake>(`/vehicle-makes/${id}`, { method: 'PATCH', ...json({ name }) }),
    onSuccess: () => invalidateDirectory(qc, true),
  });
}

export function useDeleteVehicleMake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/vehicle-makes/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateDirectory(qc, false),
  });
}

export function useRestoreVehicleMake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<VehicleMake>(`/vehicle-makes/${id}/restore`, { method: 'POST' }),
    onSuccess: () => invalidateDirectory(qc, false),
  });
}

export function useMergeVehicleMake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, targetId }: { id: string; targetId: string }) =>
      apiFetch<VehicleMake>(`/vehicle-makes/${id}/merge`, {
        method: 'POST',
        ...json({ targetId }),
      }),
    onSuccess: () => invalidateDirectory(qc, true),
  });
}

export function useCreateVehicleModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ makeId, name }: { makeId: string; name: string }) =>
      apiFetch<VehicleModel>(`/vehicle-makes/${makeId}/models`, {
        method: 'POST',
        ...json({ name }),
      }),
    onSuccess: () => invalidateDirectory(qc, false),
  });
}

export function useRenameVehicleModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      apiFetch<VehicleModel>(`/vehicle-models/${id}`, { method: 'PATCH', ...json({ name }) }),
    onSuccess: () => invalidateDirectory(qc, true),
  });
}

export function useDeleteVehicleModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/vehicle-models/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateDirectory(qc, false),
  });
}

export function useRestoreVehicleModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<VehicleModel>(`/vehicle-models/${id}/restore`, { method: 'POST' }),
    onSuccess: () => invalidateDirectory(qc, false),
  });
}

export function useMergeVehicleModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, targetId }: { id: string; targetId: string }) =>
      apiFetch<VehicleModel>(`/vehicle-models/${id}/merge`, {
        method: 'POST',
        ...json({ targetId }),
      }),
    onSuccess: () => invalidateDirectory(qc, true),
  });
}
