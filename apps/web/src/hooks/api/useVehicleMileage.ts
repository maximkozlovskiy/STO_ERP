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

const OPTS = { staleTime: 60_000, gcTime: 5 * 60_000 } as const;

export function useVehicleMileage(vehicleId: string | null) {
  return useQuery({
    queryKey: vehicleMileageKeys.byVehicle(vehicleId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<VehicleMileagePoint[]>(`/vehicles/${vehicleId}/mileage`, { signal }),
    enabled: !!vehicleId,
    ...OPTS,
  });
}
