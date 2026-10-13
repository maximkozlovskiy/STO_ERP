// Співробітники — стандарт кліку по рядку (рішення власника 2026-10-13). До цього з вимкненою
// панеллю клік нічого не робив, а в панелі не було кнопки відкриття картки.

import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import {
  itFollowsRowClickStandard,
  tableRow,
  panelShows,
} from '../../../../__tests__/row-click-standard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/employees',
}));
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
  useAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
}));

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiBlobFetch: vi.fn(),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
// Картка співробітника — маркер із id; сторінка відкриває її ПІСЛЯ довантаження GET /employees/:id.
vi.mock('@/components/ui/EmployeeEditModal', () => ({
  EmployeeEditModal: (p: { open: boolean; employee?: { id: string } | null }) =>
    p.open && p.employee ? <div data-testid="edit-card">{p.employee.id}</div> : null,
}));

const EMP_A = {
  id: 'emp-a',
  orgId: 'org-1',
  firstName: 'Іван',
  lastName: 'Петренко',
  email: 'ivan@sto.local',
  phone: '+380501112233',
  role: 'MECHANIC',
  status: 'ACTIVE',
  branchId: 'b-1',
  branchName: 'Головна філія',
  zoneIds: [] as string[],
  liftIds: [] as string[],
  skills: [] as string[],
  dateOfHire: null,
  dateOfFire: null,
  createdAt: '2026-10-13T08:00:00.000Z',
  updatedAt: '2026-10-13T08:00:00.000Z',
  deletedAt: null as string | null,
};
const EMP_B = { ...EMP_A, id: 'emp-b', firstName: 'Олег', lastName: 'Сидоренко' };

import EmployeesPage from '../page';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <EmployeesPage />
    </QueryClientProvider>,
  );
}

const card = () => screen.queryByTestId('edit-card');
// У рядку списку — «Прізвище Ім'я», у заголовку панелі — «Ім'я Прізвище».
const NAME = 'Петренко Іван';
const PANEL_TITLE = 'Іван Петренко';

describe('Співробітники — стандарт кліку по рядку', () => {
  beforeEach(() => {
    localStorage.clear();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path.startsWith('/employees?')) {
        return Promise.resolve({ items: [EMP_A, EMP_B], total: 2, page: 1, limit: 20 });
      }
      if (path === '/employees/emp-a') return Promise.resolve({ ...EMP_A, rateScheme: null });
      return Promise.resolve([]);
    });
  });

  itFollowsRowClickStandard({
    renderPage,
    panelKey: 'employees',
    rowText: NAME,
    panelTitle: PANEL_TITLE,
    pencil: row => within(row).getByTitle('Редагувати'),
    panelButton: 'Відкрити картку',
    isCardOpen: () => card()?.textContent === 'emp-a',
  });

  it('чекбокс рядка рядок не вибирає і картку не відкриває', async () => {
    renderPage();
    await screen.findByText(NAME);

    fireEvent.click(within(tableRow(NAME)).getByRole('checkbox'));

    expect(panelShows(PANEL_TITLE)).toBe(false);
    expect(card()).not.toBeInTheDocument();
    expect(apiFetchMock.mock.calls.map(c => c[0])).not.toContain('/employees/emp-a');
  });
});
