// Наряди — стандарт кліку по рядку (рішення власника 2026-10-13). До цього з вимкненою панеллю
// клік по рядку не робив нічого: у наряд можна було зайти лише олівцем.

import { render, screen, fireEvent, within } from '@testing-library/react';
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
  (await import('@/__tests__/url-store')).navigationMock('/work-orders'),
);
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
  useAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
}));
// Картку наряду сторінка вантажить ліниво (next/dynamic) — у тесті підставляємо її одразу.
vi.mock('next/dynamic', () => ({
  default: () => (p: { open: boolean; workOrderId?: string }) =>
    p.open && p.workOrderId ? <div data-testid="edit-card">{p.workOrderId}</div> : null,
}));

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiBlobFetch: vi.fn(),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));
vi.mock('@/components/ui/date-picker-input', () => ({ DatePickerInput: () => null }));

const WO_A = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: 'org-1',
  number: 'НЗ-0001',
  status: 'DRAFT',
  priority: 'NORMAL',
  repairCategory: null,
  counterpartyId: 'cp-1',
  counterpartyName: 'Клієнт Перший',
  vehicleId: 'v-1',
  vehicleSummary: 'Skoda Octavia',
  licensePlate: 'AA1234BB',
  totalAmount: 1000,
  totalLabor: 600,
  totalParts: 400,
  paidAmount: 0,
  dueDate: null,
  plannedAt: null,
  documentDate: '2026-10-13T00:00:00.000Z',
  createdAt: '2026-10-13T08:00:00.000Z',
  updatedAt: '2026-10-13T08:00:00.000Z',
  deletedAt: null as string | null,
};
const WO_B = {
  ...WO_A,
  id: '22222222-2222-4222-8222-222222222222',
  number: 'НЗ-0002',
  counterpartyName: 'Клієнт Другий',
};
let listItems = [WO_A, WO_B];

import WorkOrdersPage from '../page';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WorkOrdersPage />
    </QueryClientProvider>,
  );
}

const card = () => screen.queryByTestId('edit-card');

describe('Наряди — стандарт кліку по рядку', () => {
  beforeEach(() => {
    urlStore.reset();
    localStorage.clear();
    listItems = [WO_A, WO_B];
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path.startsWith('/work-orders?')) {
        return Promise.resolve({ items: listItems, total: listItems.length, page: 1, limit: 20 });
      }
      if (path.endsWith('/lines-summary')) return Promise.resolve({ tables: [], executors: [] });
      return Promise.resolve({});
    });
  });

  itFollowsRowClickStandard({
    renderPage,
    panelKey: 'work-orders',
    rowText: 'НЗ-0001',
    panelTitle: 'НЗ-0001',
    pencil: row => within(row).getByTitle('Відкрити наряд'),
    panelButton: 'Відкрити наряд',
    isCardOpen: () => card()?.textContent === '11111111-1111-4111-8111-111111111111',
  });

  it('чекбокс рядка рядок не вибирає і наряд не відкриває', async () => {
    renderPage();
    await screen.findByText('НЗ-0001');

    fireEvent.click(within(tableRow('НЗ-0001')).getByRole('checkbox'));

    expect(panelShows('НЗ-0001')).toBe(false);
    expect(card()).not.toBeInTheDocument();
  });

  it('олівець є і в наряду, позначеного на видалення, і відкриває його картку', async () => {
    listItems = [{ ...WO_A, deletedAt: '2026-10-13T09:00:00.000Z' }, WO_B];
    renderPage();
    await screen.findByText('НЗ-0001');

    fireEvent.click(within(tableRow('НЗ-0001')).getByTitle('Відкрити наряд'));

    expect(card()).toHaveTextContent('11111111-1111-4111-8111-111111111111');
  });
});
