// Очищення полів у картці авто (TECH-DEBT (а) 2026-11-01): картка слала `notes: notes ?? null`,
// але `vehicleUpdateSchema` (`optionalString`) робила з null `undefined`, а очищений колір ('' →
// undefined) з JSON зникав — PATCH 200, у БД старе. Тепер тіло PATCH будує
// `patchBodyWithClears(rest, vehicle, VEHICLE_CLEARABLE_FIELDS)`: поле, що мало значення і стало
// порожнім, — `null`; поле, якого в авто не було, — відсутнє.
// Мутація: повернути `JSON.stringify(rest)` → кейс «колір і нотатки → null» червоніє.

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import VehicleCardPage from '../PageClient';

const MAKE = '0a000000-0000-4000-8000-00000000a001';
const MODEL = '0a000000-0000-4000-8000-00000000b001';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => undefined,
  useAuth: () => ({ employee: { role: 'ADMIN' } }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'veh-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/vehicles/veh-1',
  useSearchParams: () => new URLSearchParams(),
}));
// Історія пробігу — окремий запит через React Query; до очищення полів стосунку не має.
vi.mock('../MileageHistory', () => ({ MileageHistory: () => null }));

const VEHICLE = {
  id: 'veh-1',
  // UUID: форма парсить customerGarageId як optionalUuid — інакше сабміт мовчки не проходить.
  customerGarageId: '0a000000-0000-4000-8000-00000000c001',
  makeId: MAKE,
  modelId: MODEL,
  make: 'BMW',
  model: 'X5',
  vin: null,
  licensePlate: 'AA1234BB',
  year: 2015,
  engineVolume: null,
  fuelType: null,
  currentMileage: null,
  color: 'Синій',
  notes: 'Старі нотатки',
  transmissionType: null,
  driveType: null,
  bodyType: null,
  engineCode: null,
  insuranceExpiry: null,
  inspectionExpiry: null,
};

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/vehicles/veh-1' && init?.method === 'PATCH') return Promise.resolve(VEHICLE);
    if (path === '/vehicles/veh-1') return Promise.resolve(VEHICLE);
    if (path === '/vehicles/veh-1/nodes') return Promise.resolve([]);
    if (path.startsWith('/maintenance-schedules')) return Promise.resolve([]);
    if (path === '/vehicle-makes') {
      return Promise.resolve({
        items: [{ id: MAKE, name: 'BMW', vehicleCount: 1, modelCount: 1, deletedAt: null }],
        total: 1,
      });
    }
    if (path === `/vehicle-makes/${MAKE}/models`) {
      return Promise.resolve({ items: [{ id: MODEL, makeId: MAKE, name: 'X5' }], total: 1 });
    }
    return Promise.resolve([]);
  });
});

const patchBody = (): Record<string, unknown> => {
  const call = apiFetchMock.mock.calls.find(
    c => c[0] === '/vehicles/veh-1' && (c[1] as RequestInit | undefined)?.method === 'PATCH',
  );
  expect(call).toBeTruthy();
  return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
};
const hasPatch = () =>
  apiFetchMock.mock.calls.some(
    c => c[0] === '/vehicles/veh-1' && (c[1] as RequestInit | undefined)?.method === 'PATCH',
  );

async function openEdit() {
  renderWithQueryClient(<VehicleCardPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Редагувати/ }));
  await screen.findByDisplayValue('Старі нотатки');
}

describe('Картка авто — очищення полів у PATCH', () => {
  it('очищені колір і нотатки → null; держномер як був; VIN, якого не було, відсутній', async () => {
    await openEdit();
    fireEvent.change(screen.getByDisplayValue('Синій'), { target: { value: '' } });
    fireEvent.change(screen.getByDisplayValue('Старі нотатки'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => expect(hasPatch()).toBe(true));
    const body = patchBody();
    expect(body).toMatchObject({ color: null, notes: null, licensePlate: 'AA1234BB' });
    expect('vin' in body).toBe(false);
    expect('customerGarageId' in body).toBe(false);
  });

  it('нічого не очищали → жодного null у тілі', async () => {
    await openEdit();
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => expect(hasPatch()).toBe(true));
    const body = patchBody();
    expect(body).toMatchObject({ color: 'Синій', notes: 'Старі нотатки' });
    expect(Object.values(body)).not.toContain(null);
  });
});
