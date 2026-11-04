// Схема нарахування в панелі списку (TECH-DEBT (а) 2026-11-04). Список не віддавав схему нікому, і панель
// показувала «Схема нарахування: —» при заданій схемі. Тепер API віддає її в рядку OWNER/ADMIN, а приймальні
// поля немає зовсім. Мутація: прибрати `canSeeRate &&` перед полем панелі → червоніє кейс приймальні.

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { tableRow, panelShows } from '../../../../__tests__/row-click-standard';

let role = 'OWNER';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/employees',
}));
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'e1', role } }),
  useAuth: () => ({ employee: { id: 'e1', role } }),
}));

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiBlobFetch: vi.fn(),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/components/ui/EmployeeEditModal', () => ({ EmployeeEditModal: () => null }));

const EMP = {
  id: 'emp-a',
  orgId: 'org-1',
  firstName: 'Іван',
  lastName: 'Петренко',
  email: null,
  phone: null,
  role: 'MECHANIC',
  status: 'ACTIVE',
  zoneIds: [] as string[],
  liftIds: [] as string[],
  dateOfHire: null,
  dateOfFire: null,
  createdAt: '2026-10-13T08:00:00.000Z',
  updatedAt: '2026-10-13T08:00:00.000Z',
  deletedAt: null,
};

import EmployeesPage from '../page';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <EmployeesPage />
    </QueryClientProvider>,
  );
}

async function openPanel() {
  renderPage();
  await screen.findByText('Петренко Іван');
  fireEvent.click(tableRow('Петренко Іван'));
  await waitFor(() => expect(panelShows('Іван Петренко')).toBe(true));
}

describe('Співробітники — схема нарахування в панелі за роллю', () => {
  beforeEach(() => {
    localStorage.clear();
    apiFetchMock.mockReset();
  });

  it('власник: схема з рядка списку видна в панелі', async () => {
    role = 'OWNER';
    const item = { ...EMP, rateScheme: { type: 'per_normo_hour', params: { ratePerHour: 200 } } };
    apiFetchMock.mockImplementation((path: string) =>
      path.startsWith('/employees?')
        ? Promise.resolve({ items: [item], total: 1, page: 1, limit: 20 })
        : Promise.resolve([]),
    );
    await openPanel();
    expect(screen.getByText('Схема нарахування')).toBeInTheDocument();
    expect(screen.getByText('Ставка × нормо-год')).toBeInTheDocument();
  });

  it('приймальня: поля схеми в панелі немає (не «—»)', async () => {
    role = 'RECEPTIONIST';
    apiFetchMock.mockImplementation((path: string) =>
      path.startsWith('/employees?')
        ? Promise.resolve({ items: [EMP], total: 1, page: 1, limit: 20 })
        : Promise.resolve([]),
    );
    await openPanel();
    expect(screen.queryByText('Схема нарахування')).not.toBeInTheDocument();
  });
});
