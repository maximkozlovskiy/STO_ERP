// Контрагенти — стандарт кліку по рядку (рішення власника 2026-10-13). До цього з вимкненою
// панеллю клік нічого не робив, а в панелі не було кнопки відкриття картки.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { urlStore } from '@/__tests__/url-store';
import {
  itFollowsRowClickStandard,
  tableRow,
  panelShows,
} from '../../../../__tests__/row-click-standard';

// Картка — в адресі (`?open=<id>`): адреса мусить реагувати на push / replace / back.
vi.mock('next/navigation', async () =>
  (await import('@/__tests__/url-store')).navigationMock('/counterparties'),
);
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
// Картка контрагента — маркер із id контрагента, з яким її відкрили; «mock-save» — збереження
// картки (onSaved), щоб перевірити оновлення панелі.
vi.mock('@/components/ui/CounterpartyEditModal', () => ({
  CounterpartyEditModal: (p: {
    open: boolean;
    counterparty?: { id: string } | null;
    onSaved: (cp: unknown, isNew: boolean) => void;
  }) =>
    p.open && p.counterparty ? (
      <>
        <div data-testid="edit-card">{p.counterparty.id}</div>
        <button onClick={() => p.onSaved(p.counterparty, false)}>mock-save</button>
      </>
    ) : null,
}));

const CP_A = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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
const CP_B = { ...CP_A, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', companyName: 'ТОВ Другий' };
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
    urlStore.reset();
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
    isCardOpen: () => card()?.textContent === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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

  // TECH-DEBT §8: панель тримала копію рядка і після збереження картки показувала старі дані.
  // Мутація: прибрати `useSelectedRowRefresh` у page.tsx → кейс падає.
  it('після збереження картки з панелі панель показує перечитаний рядок, а не стару копію', async () => {
    renderPage();
    await screen.findByText('ТОВ Перший');
    await screen.findByRole('button', { name: 'Сховати бокову панель' });

    fireEvent.click(tableRow('ТОВ Перший'));
    await waitFor(() => expect(panelShows('ТОВ Перший')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Відкрити картку' }));
    await screen.findByTestId('edit-card');

    listItems = [{ ...CP_A, companyName: 'ТОВ Перший Плюс' }, CP_B];
    fireEvent.click(screen.getByRole('button', { name: 'mock-save' }));

    await waitFor(() => expect(panelShows('ТОВ Перший Плюс')).toBe(true));
    expect(panelShows('ТОВ Перший')).toBe(false);
  });
});
