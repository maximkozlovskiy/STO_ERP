// Контрагенти — стандарт кліку по рядку (рішення власника 2026-10-13). До цього з вимкненою
// панеллю клік нічого не робив, а в панелі не було кнопки відкриття картки.

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
  usePathname: () => '/counterparties',
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
// Картка контрагента — маркер із id контрагента, з яким її відкрили.
vi.mock('@/components/ui/CounterpartyEditModal', () => ({
  CounterpartyEditModal: (p: { open: boolean; counterparty?: { id: string } | null }) =>
    p.open && p.counterparty ? <div data-testid="edit-card">{p.counterparty.id}</div> : null,
}));

const CP_A = {
  id: 'cp-a',
  orgId: 'org-1',
  type: 'CLIENT',
  companyName: 'ТОВ Перший',
  firstName: null,
  lastName: null,
  phone: '+380501112233',
  email: null,
  vatPayer: false,
  balance: 0,
  createdAt: '2026-10-13T08:00:00.000Z',
  updatedAt: '2026-10-13T08:00:00.000Z',
  deletedAt: null as string | null,
};
const CP_B = { ...CP_A, id: 'cp-b', companyName: 'ТОВ Другий' };
let listItems = [CP_A, CP_B];

import CounterpartiesPage from '../page';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CounterpartiesPage />
    </QueryClientProvider>,
  );
}

const card = () => screen.queryByTestId('edit-card');

describe('Контрагенти — стандарт кліку по рядку', () => {
  beforeEach(() => {
    localStorage.clear();
    listItems = [CP_A, CP_B];
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path.startsWith('/counterparties?')) {
        return Promise.resolve({ items: listItems, total: listItems.length, page: 1, limit: 20 });
      }
      if (path.includes('/vehicles')) return Promise.resolve([]);
      return Promise.resolve({});
    });
  });

  itFollowsRowClickStandard({
    renderPage,
    panelKey: 'crm',
    rowText: 'ТОВ Перший',
    panelTitle: 'ТОВ Перший',
    pencil: row => within(row).getByTitle('Редагувати'),
    panelButton: 'Відкрити картку',
    isCardOpen: () => card()?.textContent === 'cp-a',
  });

  it('чекбокс рядка рядок не вибирає і картку не відкриває', async () => {
    renderPage();
    await screen.findByText('ТОВ Перший');

    fireEvent.click(within(tableRow('ТОВ Перший')).getByRole('checkbox'));

    expect(panelShows('ТОВ Перший')).toBe(false);
    expect(card()).not.toBeInTheDocument();
  });

  // Довідник: видалений контрагент картки не має (олівця в рядку немає) — стандарт цього не міняє.
  it('видалений контрагент: з вимкненою панеллю клік нічого не відкриває; у панелі кнопки картки немає', async () => {
    listItems = [{ ...CP_A, deletedAt: '2026-10-13T09:00:00.000Z' }, CP_B];
    localStorage.setItem('sto_detail_panel_crm', 'false');
    renderPage();
    await screen.findByText('ТОВ Перший');
    await screen.findByRole('button', { name: 'Показати бокову панель' });

    fireEvent.click(tableRow('ТОВ Перший'));
    expect(card()).not.toBeInTheDocument();
    expect(within(tableRow('ТОВ Перший')).queryByTitle('Редагувати')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Показати бокову панель' }));
    fireEvent.click(tableRow('ТОВ Перший'));
    await waitFor(() => expect(panelShows('ТОВ Перший')).toBe(true));
    expect(screen.queryByText('Відкрити картку')).not.toBeInTheDocument();
  });
});
