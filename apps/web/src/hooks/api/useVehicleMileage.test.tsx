// useVehicleMileage — історія пробігу авто (GET /vehicles/:id/mileage → VehicleMileagePoint[]).
// Стереже контракт із бекендом: точний шлях, передачу AbortSignal, голий масив у відповіді
// та те, що без vehicleId запит не йде взагалі.
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import type { VehicleMileagePoint } from '@sto/shared';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { vehicleMileageKeys, useVehicleMileage } from './useVehicleMileage';

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

const POINTS: VehicleMileagePoint[] = [
  {
    workOrderId: 'wo-1',
    workOrderNumber: 'НРД-2026-0001',
    date: '2026-03-01T10:00:00.000Z',
    mileage: 85000,
    isRollback: false,
  },
  {
    workOrderId: 'wo-2',
    workOrderNumber: 'НРД-2026-0002',
    date: '2026-06-01T10:00:00.000Z',
    mileage: 84000,
    isRollback: true,
  },
];

describe('useVehicleMileage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('vehicleMileageKeys: різні авто → різні ключі зі спільним префіксом', () => {
    expect(vehicleMileageKeys.all).toEqual(['vehicle-mileage']);
    expect(vehicleMileageKeys.byVehicle('a')).toEqual(['vehicle-mileage', 'a']);
    expect(vehicleMileageKeys.byVehicle('a')).not.toEqual(vehicleMileageKeys.byVehicle('b'));
  });

  it('GET /vehicles/:id/mileage із signal; повертає масив як є', async () => {
    apiFetchMock.mockResolvedValueOnce(POINTS);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useVehicleMileage('v-1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/vehicles/v-1/mileage',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.current.data).toEqual(POINTS);
  });

  it('Bug #799: повторне відкриття картки авто перечитує історію, а не бере кеш до 60 с', async () => {
    // Продакшн-клієнт має staleTime 30 с за замовчуванням — відтворюємо його, щоб тест
    // перевіряв саме налаштування хука, а не типову поведінку «голого» QueryClient.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const fixed: VehicleMileagePoint[] = [
      POINTS[0]!,
      { ...POINTS[1]!, mileage: 86000, isRollback: false },
    ];
    apiFetchMock.mockResolvedValueOnce(POINTS).mockResolvedValueOnce(fixed);

    // 1) картка авто відкрита: історія з відкатом
    const first = renderHook(() => useVehicleMileage('v-1'), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(first.result.current.data?.[1]?.isRollback).toBe(true);
    // 2) перехід у наряд (картка розмонтована), пробіг виправлено
    first.unmount();
    // 3) повернення на картку в межах хвилини
    const second = renderHook(() => useVehicleMileage('v-1'), { wrapper });
    // кеш показано одразу — без скелетона
    expect(second.result.current.isLoading).toBe(false);
    expect(second.result.current.data).toEqual(POINTS);

    await waitFor(() => expect(second.result.current.data).toEqual(fixed));
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('vehicleId = null → запит не виконується', () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useVehicleMileage(null), { wrapper });

    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('помилка API (напр. 404 чужої org) → isError з повідомленням бекенду', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('Автомобіль не знайдено'));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useVehicleMileage('v-x'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.message).toBe('Автомобіль не знайдено');
  });
});
