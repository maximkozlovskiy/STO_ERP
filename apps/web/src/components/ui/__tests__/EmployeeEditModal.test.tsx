// Regression-guard для EmployeeEditModal.
//
// Bug guarded (audit 2026-09-05, Bug #633 / WEB-H3, клас Bug #630):
//   Модалка НЕ мала синхронного savingRef — save() робить кілька послідовних POST
//   (employee + auth-account). Подвійний клік у одному tick → дубль співробітника +
//   дубль auth-акаунта. Тепер `if (savingRef.current) return` першим рядком save().
//
// ⚠️ ТЕСТ-ІНТЕГРІТІ: native HTMLElement.click() ×2 синхронно (НЕ userEvent — той дає
// React re-renderнути disabled={loading} між кліками → хибно-зелений). Див. GoodEditModal.test.

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { EmployeeEditModal } from '../EmployeeEditModal';

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

vi.mock('@/hooks/useDirtyForm', () => ({
  useDirtyForm: () => ({
    isDirty: false,
    markDirty: vi.fn(),
    resetDirty: vi.fn(),
    confirmClose: () => Promise.resolve(true),
  }),
}));

describe('EmployeeEditModal — double-submit guard (Bug #633 / WEB-H3)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('подвійний синхронний клік «Зберегти» шле POST /employees лише один раз', async () => {
    let resolveCreate: (v: unknown) => void = () => {};
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      // Ref-data (zones/lifts/work-categories/branches) — одразу.
      if (
        path === '/zones' ||
        path === '/lifts' ||
        path === '/work-categories' ||
        path === '/branches'
      ) {
        return Promise.resolve([]);
      }
      if (path === '/employees' && init?.method === 'POST') {
        return new Promise(resolve => {
          resolveCreate = resolve;
        });
      }
      return Promise.resolve({ items: [] });
    });

    render(<EmployeeEditModal open employee={null} onClose={() => {}} onSaved={() => {}} />);

    // Ввести ім'я/прізвище — кнопка disabled={!firstName || !lastName}.
    fireEvent.change(screen.getByPlaceholderText('Іван'), { target: { value: 'Іван' } });
    fireEvent.change(screen.getByPlaceholderText('Коваль'), { target: { value: 'Коваль' } });

    const saveBtn = screen.getByRole('button', { name: 'Зберегти' }) as HTMLButtonElement;

    // Два синхронних native-кліки в одному tick (див. коментар угорі).
    saveBtn.click();
    saveBtn.click();

    await waitFor(() => {
      const postCalls = apiFetchMock.mock.calls.filter(
        c => c[0] === '/employees' && (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(postCalls.length).toBe(1);
    });

    await act(async () => {
      resolveCreate({
        id: 'e1',
        firstName: 'Іван',
        lastName: 'Коваль',
        role: 'MECHANIC',
        phone: null,
        status: 'ACTIVE',
        zoneIds: [],
        liftIds: [],
        workCategoryIds: [],
        branchIds: [],
        allBranches: false,
      });
    });
  });
});
