// Очищення полів у картці працівника (TECH-DEBT (а) 2026-11-01): картка слала
// `phone: values.phone || undefined` — очищений телефон зникав із JSON, PATCH 200, у БД старий.
// Тепер тіло PATCH будує `patchBodyWithClears(payload, employee, EMPLOYEE_CLEARABLE_FIELDS)`:
// поле, що мало значення і стало порожнім, — `null`; поле, якого в працівника не було, — відсутнє.
// Мутація: повернути `JSON.stringify(payload)` → кейс «телефон → null» червоніє.

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { EmployeeEditModal, type EmployeeForModal } from '../EmployeeEditModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/lib/ref-cache', () => ({
  getCached: () => null,
  setCache: vi.fn(),
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: false, unsavedGuardEnabled: false }),
}));

const EMP: EmployeeForModal = {
  id: 'e-1',
  firstName: 'Іван',
  lastName: 'Коваль',
  role: 'MECHANIC',
  phone: '+380501112233',
  email: 'ivan@sto.test',
  status: 'ACTIVE',
  dateOfHire: null,
  dateOfFire: null,
  rateScheme: { type: 'percent_normo', params: { percent: 40 } },
  zoneIds: [],
  liftIds: [],
  workCategoryIds: [],
  branchIds: [],
  allBranches: true,
};

const patchBody = (): Record<string, unknown> => {
  const call = apiFetchMock.mock.calls.find(
    c => c[0] === '/employees/e-1' && (c[1] as RequestInit | undefined)?.method === 'PATCH',
  );
  expect(call).toBeTruthy();
  return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
};

describe('EmployeeEditModal — очищення полів у PATCH', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (['/zones', '/lifts', '/work-categories', '/branches'].includes(path)) {
        return Promise.resolve([]);
      }
      if (path === '/employees/e-1' && init?.method === 'PATCH') return Promise.resolve(EMP);
      return Promise.resolve(undefined);
    });
  });

  const hasPatch = () =>
    apiFetchMock.mock.calls.some(
      c => c[0] === '/employees/e-1' && (c[1] as RequestInit | undefined)?.method === 'PATCH',
    );

  it('очищений телефон → phone: null; e-mail як був; дат, яких не було, у тілі немає', async () => {
    render(<EmployeeEditModal open employee={EMP} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(await screen.findByDisplayValue('+380501112233'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => expect(hasPatch()).toBe(true));
    const body = patchBody();
    expect(body).toHaveProperty('phone', null);
    expect(body).toHaveProperty('email', 'ivan@sto.test');
    expect('dateOfHire' in body).toBe(false);
    expect('dateOfFire' in body).toBe(false);
  });

  it('очищені телефон і e-mail → обидва null', async () => {
    render(<EmployeeEditModal open employee={EMP} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(await screen.findByDisplayValue('+380501112233'), { target: { value: '' } });
    fireEvent.change(screen.getByDisplayValue('ivan@sto.test'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

    await waitFor(() => expect(hasPatch()).toBe(true));
    expect(patchBody()).toMatchObject({ phone: null, email: null });
  });
});
