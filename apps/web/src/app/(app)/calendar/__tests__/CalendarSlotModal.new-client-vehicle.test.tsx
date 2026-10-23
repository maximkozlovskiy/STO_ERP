// Майстер «Новий клієнт» у формі запису календаря, крок «Автомобіль клієнта»: марка й модель —
// вибір із довідника (BR-VEH-008). Раніше тут були вільні текстові поля, і `POST /vehicles` ніс
// рядки `make` / `model`; тепер — `makeId` / `modelId`, «Зберегти» — лише з обома.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryWrapper } from '@/__tests__/query-utils';
import {
  pickVehicleDirectoryItem,
  vehicleDirectoryField,
  vehicleDirectoryPickButton,
  vehicleDirectorySearch,
} from '@/__tests__/vehicle-directory-picker';

const L1 = '11111111-1111-4111-8111-000000000001';
const CP = '33333333-3333-4333-8333-000000000001';
const GARAGE = '55555555-5555-4555-8555-000000000001';
const TOYOTA = '66666666-6666-4666-8666-000000000001';
const BMW = '66666666-6666-4666-8666-000000000002';
const CAMRY = '77777777-7777-4777-8777-000000000001';
const X5 = '77777777-7777-4777-8777-000000000002';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/ui/CounterpartyEditModal', () => ({ CounterpartyEditModal: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/calendar',
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { role: 'RECEPTIONIST' } }) }));

import { CalendarSlotModal } from '../CalendarSlotModal';
import { EMPTY_FORM } from '../useCalendarState';
import type { SlotForm } from '../calendar.types';

function Harness() {
  const [form, setForm] = useState<SlotForm>({
    ...EMPTY_FORM,
    liftId: L1,
    startAt: '10:00',
    endAt: '11:00',
    normoHours: '1',
  });
  return (
    <CalendarSlotModal
      open
      onClose={() => {}}
      onSaved={() => {}}
      onDeleted={() => {}}
      date="2026-10-20"
      lifts={[{ id: L1, name: 'П1' }]}
      form={form}
      setForm={setForm}
      editingSlotId={null}
      isEditingPast={false}
      pendingSlot={null}
      setPendingSlot={() => {}}
      formMounted
      formVisible
      formCollapseRef={createRef<HTMLDivElement>()}
      formInnerRef={createRef<HTMLDivElement>()}
      minHour={8}
      windowStart={8}
      windowEnd={20}
      nowMs={new Date('2026-10-15T12:00:00+03:00').getTime()}
      error=""
      setError={() => {}}
      saving={false}
      setSaving={() => {}}
      cpDisplay=""
      setCpDisplay={() => {}}
    />
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/counterparties' && init?.method === 'POST') return Promise.resolve({ id: CP });
    if (url === `/counterparties/${CP}/garages`)
      return Promise.resolve([{ id: GARAGE, isDefault: true }]);
    if (url === '/vehicles' && init?.method === 'POST') return Promise.resolve({ id: 'veh-new' });
    if (url === '/vehicle-makes')
      return Promise.resolve({
        items: [
          { id: TOYOTA, name: 'Toyota', vehicleCount: 0, modelCount: 1, deletedAt: null },
          { id: BMW, name: 'BMW', vehicleCount: 0, modelCount: 1, deletedAt: null },
        ],
        total: 2,
      });
    if (url === `/vehicle-makes/${TOYOTA}/models`)
      return Promise.resolve({ items: [{ id: CAMRY, makeId: TOYOTA, name: 'Camry' }], total: 1 });
    if (url === `/vehicle-makes/${BMW}/models`)
      return Promise.resolve({ items: [{ id: X5, makeId: BMW, name: 'X5' }], total: 1 });
    if (url.startsWith('/calendar/slots/check-conflicts'))
      return Promise.resolve({ anyConflict: false, conflictSlots: [] });
    if (url.startsWith('/vehicles')) return Promise.resolve([]);
    return Promise.resolve({ items: [] });
  });
});

async function openVehicleStep() {
  render(<Harness />, { wrapper: createQueryWrapper() });
  fireEvent.click(screen.getByTitle('Новий клієнт'));
  fireEvent.change(await screen.findByLabelText("Ім'я"), { target: { value: 'Іван' } });
  fireEvent.click(screen.getByRole('button', { name: 'Далі →' }));
  await screen.findByText('Автомобіль клієнта');
}

const wizard = () => screen.getByRole('dialog', { name: 'Автомобіль клієнта' });
const saveButton = () => within(wizard()).getByRole('button', { name: 'Зберегти' });

describe('CalendarSlotModal — майстер «Новий клієнт», авто з довідника (BR-VEH-008)', () => {
  // guards: BR-VEH-008
  it('«Зберегти» — лише з маркою й моделлю; POST /vehicles несе makeId / modelId', async () => {
    await openVehicleStep();
    expect(saveButton()).toBeDisabled();
    expect(vehicleDirectorySearch('model')).toBeDisabled();

    await pickVehicleDirectoryItem('make', 'Toyota');
    expect(saveButton()).toBeDisabled();
    await pickVehicleDirectoryItem('model', 'Camry');
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/vehicles',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const call = apiFetch.mock.calls.find(c => c[0] === '/vehicles' && c[1]?.method === 'POST');
    const body = JSON.parse((call![1] as { body: string }).body) as Record<string, unknown>;
    expect(body).toMatchObject({ customerGarageId: GARAGE, makeId: TOYOTA, modelId: CAMRY });
    expect(body).not.toHaveProperty('make');
    expect(body).not.toHaveProperty('model');
  });

  // guards: BR-VEH-008
  it('зміна марки скидає модель — «Зберегти» знову недоступне', async () => {
    await openVehicleStep();
    await pickVehicleDirectoryItem('make', 'Toyota');
    await pickVehicleDirectoryItem('model', 'Camry');
    expect(saveButton()).toBeEnabled();

    await pickVehicleDirectoryItem('make', 'BMW');

    expect(vehicleDirectoryField('model')).not.toHaveTextContent('Camry');
    expect(saveButton()).toBeDisabled();
    await pickVehicleDirectoryItem('model', 'X5');
    expect(saveButton()).toBeEnabled();
  });

  // GOTCHAS 2026-10-21: вікно вибору марки — шар Escape над майстром.
  it('Escape у «Оберіть марку» закриває лише вікно вибору — майстер лишається з введеним', async () => {
    await openVehicleStep();
    await pickVehicleDirectoryItem('make', 'Toyota');
    fireEvent.click(vehicleDirectoryPickButton('model'));
    await screen.findByRole('dialog', { name: 'Оберіть модель' });

    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Оберіть модель' })).not.toBeInTheDocument(),
    );
    expect(wizard()).toBeInTheDocument();
    expect(vehicleDirectoryField('make')).toHaveTextContent('Toyota');
  });
});
