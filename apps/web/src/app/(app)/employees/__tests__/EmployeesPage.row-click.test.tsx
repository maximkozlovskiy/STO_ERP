// Співробітники — стандарт кліку по рядку (рішення власника 2026-10-13). До цього з вимкненою
// панеллю клік нічого не робив, а в панелі не було кнопки відкриття картки.
//
// Також: картка видаленого — з рядка, без GET /employees/:id (BR-EMP-002), і панель
// перечитує рядок після збереження картки (TECH-DEBT §8 «панель тримає копію рядка»).
// Мутації: прибрати `useSelectedRowRefresh` у page.tsx → падає «панель показує свіже»;
// прибрати `if (!emp.deletedAt)` перед запитом → падає «видалений: без запиту».

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
// «mock-save» — збереження картки (onSaved), щоб перевірити оновлення панелі.
vi.mock('@/components/ui/EmployeeEditModal', () => ({
  EmployeeEditModal: (p: {
    open: boolean;
    employee?: { id: string; deletedAt?: string | null } | null;
    onSaved: (e: unknown) => void;
  }) =>
    p.open && p.employee ? (
      <>
        <div data-testid="edit-card" data-deleted={p.employee.deletedAt ? 'yes' : 'no'}>
          {p.employee.id}
        </div>
        <button onClick={() => p.onSaved(p.employee)}>mock-save</button>
      </>
    ) : null,
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
let listItems = [EMP_A, EMP_B];

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
    listItems = [EMP_A, EMP_B];
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path.startsWith('/employees?')) {
        return Promise.resolve({ items: listItems, total: listItems.length, page: 1, limit: 20 });
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

  it('після збереження картки з панелі панель показує перечитаний рядок, а не стару копію', async () => {
    renderPage();
    await screen.findByText(NAME);
    await screen.findByRole('button', { name: 'Сховати бокову панель' });

    fireEvent.click(tableRow(NAME));
    await waitFor(() => expect(panelShows(PANEL_TITLE)).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Відкрити картку' }));
    await screen.findByTestId('edit-card');

    // Картка зберегла нове прізвище — список після інвалідації приходить уже з ним.
    listItems = [{ ...EMP_A, lastName: 'Петренко-Коваль' }, EMP_B];
    fireEvent.click(screen.getByRole('button', { name: 'mock-save' }));

    await waitFor(() => expect(panelShows('Іван Петренко-Коваль')).toBe(true));
    expect(panelShows(PANEL_TITLE)).toBe(false);
  });
});

// guards: BR-EMP-002
describe('Співробітники — видалений співробітник: картка лише на перегляд', () => {
  const DELETED = { ...EMP_A, deletedAt: '2026-10-20T09:00:00.000Z' };

  beforeEach(() => {
    localStorage.clear();
    listItems = [DELETED, EMP_B];
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path.startsWith('/employees?')) {
        return Promise.resolve({ items: listItems, total: listItems.length, page: 1, limit: 20 });
      }
      // Сервер видаленого не віддає (findOne з deletedAt: null).
      if (path === '/employees/emp-a')
        return Promise.reject(new Error('Співробітника не знайдено'));
      return Promise.resolve([]);
    });
  });

  it('клік (панель вимкнена) відкриває картку видаленого з рядка — без GET /employees/:id', async () => {
    localStorage.setItem('sto_detail_panel_employees', 'false');
    renderPage();
    await screen.findByText(NAME);
    await screen.findByRole('button', { name: 'Показати бокову панель' });

    fireEvent.click(tableRow(NAME));

    expect((await screen.findByTestId('edit-card')).dataset.deleted).toBe('yes');
    expect(card()?.textContent).toBe('emp-a');
    expect(apiFetchMock.mock.calls.map(c => c[0])).not.toContain('/employees/emp-a');
  });

  it('у рядку видаленого немає «Помітити на видалення»; олівець відкриває картку', async () => {
    renderPage();
    await screen.findByText(NAME);

    const row = tableRow(NAME);
    expect(within(row).queryByTitle('Помітити на видалення')).not.toBeInTheDocument();
    expect(
      within(tableRow('Сидоренко Олег')).getByTitle('Помітити на видалення'),
    ).toBeInTheDocument();

    fireEvent.click(within(row).getByTitle('Редагувати'));
    expect((await screen.findByTestId('edit-card')).dataset.deleted).toBe('yes');
  });
});
