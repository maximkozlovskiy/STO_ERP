import { useQuery } from '@tanstack/react-query';
import type { VehicleMileagePoint } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';

/**
 * Історія пробігу авто. Backend: GET /vehicles/:id/mileage → VehicleMileagePoint[]
 * (голий масив, НЕ `{items,total}`), від старішого до новішого, до 200 записів.
 * Тип — лише з @sto/shared: той самий контракт читає бекенд, локальний дубль розійшовся б.
 */
export const vehicleMileageKeys = {
  all: ['vehicle-mileage'] as const,
  byVehicle: (vehicleId: string) => [...vehicleMileageKeys.all, vehicleId] as const,
};

/**
 * staleTime: 0 — історія перечитується щоразу, коли відкривають картку авто (Bug #799).
 * Вона будується з нарядів, а наряд міняють у багатьох місцях, які цей ключ не інвалідовують:
 * реквізити в картці наряду (пробіг, дата), створення наряду, планшет механіка, інший
 * користувач. Із staleTime 60 с шлях «побачив відкат → відкрив наряд → виправив пробіг →
 * повернувся» показував стару історію з тим самим попередженням. Решта картки авто й так
 * вантажиться заново на кожне відкриття; gcTime лишає кеш, тож повернення не блимає
 * скелетоном — старі дані видно, доки йде фоновий запит.
 */
const OPTS = { staleTime: 0, gcTime: 5 * 60_000 } as const;

export function useVehicleMileage(vehicleId: string | null) {
  return useQuery({
    queryKey: vehicleMileageKeys.byVehicle(vehicleId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<VehicleMileagePoint[]>(`/vehicles/${vehicleId}/mileage`, { signal }),
    enabled: !!vehicleId,
    ...OPTS,
  });
}
