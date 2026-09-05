// Regression-guard для WorkOrderAddLineModal.
//
// Bug guarded (audit 2026-09-05, Bug #635 / WEB-H3, клас Bug #630):
//   handleAdd() робив POST /work-orders/:id/lines без синхронного savingRef. Кнопка
//   «Додати» disabled лише за !workId/!employeeId (не saving) → два same-tick кліки →
//   2× POST → дубль роботи (подвійне нарахування праці). Тепер `if (savingRef.current) return`.
//
// ⚠️ ТЕСТ-ІНТЕГРІТІ: native HTMLElement.click() ×2 синхронно (НЕ userEvent/fireEvent×2 —
// ті дають React re-renderнути disabled={loading} між кліками → хибно-зелений).

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { WorkOrderAddLineModal } from '../WorkOrderAddLineModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
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

const works = [{ id: 'wk1', name: 'Заміна масла', normoHours: 1, price: 300 }];
const employees = [{ id: 'em1', firstName: 'Іван', lastName: 'Коваль' }];

describe('WorkOrderAddLineModal — double-submit guard (Bug #635 / WEB-H3)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('подвійний синхронний клік «Додати» шле POST /lines лише один раз', async () => {
    let resolveAdd: (v: unknown) => void = () => {};
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/work-orders/wo1/lines' && init?.method === 'POST') {
        return new Promise(resolve => {
          resolveAdd = resolve;
        });
      }
      return Promise.resolve({ items: [] });
    });

    render(
      <WorkOrderAddLineModal
        open
        workOrderId="wo1"
        works={works as never}
        employees={employees as never}
        onClose={() => {}}
        onAdded={() => {}}
      />,
    );

    // Обрати роботу + виконавця — кнопка disabled={!workId || !employeeId}.
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'wk1' } });
    fireEvent.change(selects[1], { target: { value: 'em1' } });

    const addBtn = screen.getByRole('button', { name: 'Додати' }) as HTMLButtonElement;

    addBtn.click();
    addBtn.click();

    await waitFor(() => {
      const postCalls = apiFetchMock.mock.calls.filter(
        c =>
          c[0] === '/work-orders/wo1/lines' && (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(postCalls.length).toBe(1);
    });

    await act(async () => {
      resolveAdd({ id: 'l1' });
    });
  });
});
