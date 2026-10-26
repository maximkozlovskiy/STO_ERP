// Масові дії на сторінці співробітників показують ТЕКСТ СЕРВЕРА, а не лише «n з m»
// (TECH-DEBT §8, tester 2026-10-13): при самозвільненні користувач бачив «Звільнено 1 з 2.
// 1 не вдалося» і не знав чому; в одиничній картці той самий текст сервера показувався.
//
// Мутація: прибрати `reasons` з повідомлення у `reportBulkResult` (page.tsx) → падають усі
// три кейси; прибрати `new Set` → падає кейс про однаковий текст двох відмов.

import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { tableRow } from '../../../../__tests__/row-click-standard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/employees',
}));
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
  useAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));
const features = vi.hoisted(() => ({ toastEnabled: true }));
vi.mock('@/hooks/useUiFeatures', async importOriginal => {
  const mod = await importOriginal<typeof import('@/hooks/useUiFeatures')>();
  return {
    ...mod,
    useUiFeatures: () => ({ ...mod.useUiFeatures(), toastEnabled: features.toastEnabled }),
  };
});

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiBlobFetch: vi.fn(),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/components/ui/EmployeeEditModal', () => ({ EmployeeEditModal: () => null }));

const SELF_MSG = 'Не можна звільнити самого себе: це закрило б вам вхід у систему';

const EMP_A = {
  id: 'emp-a',
  firstName: 'Іван',
  lastName: 'Петренко',
  phone: null,
  role: 'OWNER',
  status: 'ACTIVE',
  zoneIds: [] as string[],
  liftIds: [] as string[],
  workCategoryIds: [] as string[],
  branchIds: [] as string[],
  allBranches: true,
  deletedAt: null as string | null,
};
const EMP_B = { ...EMP_A, id: 'emp-b', firstName: 'Олег', lastName: 'Сидоренко', role: 'MECHANIC' };

import EmployeesPage from '../page';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <EmployeesPage />
    </QueryClientProvider>,
  );
}

/** Вибрати обидва рядки, натиснути масову дію й підтвердити. */
async function runBulk(action: string) {
  renderPage();
  await screen.findByText('Петренко Іван');
  fireEvent.click(within(tableRow('Петренко Іван')).getByRole('checkbox'));
  fireEvent.click(within(tableRow('Сидоренко Олег')).getByRole('checkbox'));
  fireEvent.click(await screen.findByRole('button', { name: action }));
  fireEvent.click(await screen.findByRole('button', { name: 'Так' }));
}

describe('Співробітники — масові дії показують текст сервера', () => {
  beforeEach(() => {
    localStorage.clear();
    features.toastEnabled = true;
    toastMock.success.mockReset();
    toastMock.warning.mockReset();
    toastMock.error.mockReset();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith('/employees?')) {
        return Promise.resolve({ items: [EMP_A, EMP_B], total: 2, page: 1, limit: 20 });
      }
      if (path === '/employees/emp-a' && init?.method === 'PATCH') {
        return Promise.reject(new Error(SELF_MSG));
      }
      if (path.startsWith('/employees/') && init?.method === 'DELETE') {
        return Promise.reject(new Error('Співробітник є виконавцем в активному наряді'));
      }
      return Promise.resolve({});
    });
  });

  it('самозвільнення серед двох: попередження містить «Не можна звільнити самого себе»', async () => {
    await runBulk('Звільнити вибраних');

    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));
    const msg = String(toastMock.warning.mock.calls[0]![0]);
    expect(msg).toContain('Звільнено 1 з 2');
    expect(msg).toContain(SELF_MSG);
  });

  it('дві відмови з однаковим текстом: текст сервера один раз', async () => {
    await runBulk('Видалити вибраних');

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    const msg = String(toastMock.error.mock.calls[0]![0]);
    expect(msg).toContain('Не вдалося видалити жодного співробітника');
    expect(msg.split('Співробітник є виконавцем в активному наряді')).toHaveLength(2);
  });

  it('toast-и вимкнені: текст сервера видно в смузі помилки сторінки', async () => {
    features.toastEnabled = false;
    await runBulk('Звільнити вибраних');

    expect(await screen.findByText(new RegExp(SELF_MSG))).toBeInTheDocument();
    expect(toastMock.warning).not.toHaveBeenCalled();
  });
});
