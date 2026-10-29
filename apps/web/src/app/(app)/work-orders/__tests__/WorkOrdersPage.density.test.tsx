// Щільність списку нарядів (UX-огляд 2026-10-29, частина 4):
//   · Підйомник / «Заплановано» / «Дедлайн» типово сховані (повертаються в «Колонках»);
//   · дії рядка — липка колонка праворуч;
//   · пріоритет змінюється лише явною кнопкою поруч із бейджем і не в закритих статусах
//     (`WO_CLOSED_STATUSES`: сервер не приймає PATCH) — клік по бейджу select не відкриває.
//
// Mutation-verify (2026-10-29): прибрати `!WO_CLOSED_STATUSES.includes` → падає «закриті статуси»;
// повернути Підйомнику типову видимість → падає «типово сховані».
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { WO_CLOSED_STATUSES } from '@sto/shared';
import { urlStore } from '@/__tests__/url-store';

vi.mock('next/navigation', async () =>
  (await import('@/__tests__/url-store')).navigationMock('/work-orders'),
);
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'me', role: 'OWNER' } }),
  useAuth: () => ({ employee: { id: 'me', role: 'OWNER' } }),
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
let rows: unknown[] = [];
vi.mock('@/lib/api-client', () => ({
  apiFetch: (url: string) =>
    Promise.resolve(
      String(url).startsWith('/work-orders?')
        ? { items: rows, total: rows.length, page: 1, limit: 20 }
        : {},
    ),
  apiBlobFetch: vi.fn(),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));
vi.mock('@/components/ui/date-picker-input', () => ({ DatePickerInput: () => null }));

import WorkOrdersPage from '../page';

const row = (n: number, status: string) => ({
  id: `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${String(n).repeat(12)}`,
  number: `НРД-00000${n}`,
  status,
  priority: 'NORMAL',
  counterpartyName: 'Клієнт',
  vehicleSummary: 'Авто',
  totalAmount: 0,
  paidAmount: 0,
  totalLabor: 0,
  totalActualLabor: 0,
  totalParts: 0,
  documentDate: '2026-10-29',
  deletedAt: null,
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WorkOrdersPage />
    </QueryClientProvider>,
  );
}
const tableRow = (number: string) => screen.getByRole('link', { name: number }).closest('tr')!;

describe('список нарядів — щільність', () => {
  beforeEach(() => {
    urlStore.reset();
    localStorage.clear();
    rows = [row(1, 'DRAFT')];
  });

  it('Підйомник, «Заплановано», «Дедлайн» типово сховані; колонка дій — липка', async () => {
    renderPage();
    await screen.findByRole('link', { name: 'НРД-000001' });
    const headers = screen.getAllByRole('columnheader').map(h => h.textContent ?? '');
    for (const hidden of ['Підйомник', 'Заплановано', 'Дедлайн'])
      expect(headers.some(h => h.includes(hidden))).toBe(false);
    expect(headers.some(h => h.includes('Дата документа'))).toBe(true);
    const actions = screen.getAllByRole('columnheader').at(-1)!;
    expect(actions.className).toMatch(/sticky right-0/);
  });

  it('відкритий наряд: пріоритет змінює кнопка поруч із бейджем; бейдж select не відкриває', async () => {
    renderPage();
    await screen.findByRole('link', { name: 'НРД-000001' });
    const tr = tableRow('НРД-000001');
    fireEvent.click(within(tr).getByText('Звичайний'));
    expect(within(tr).queryByRole('combobox')).toBeNull();
    fireEvent.click(
      within(tr).getByRole('button', { name: 'Змінити пріоритет наряду НРД-000001' }),
    );
    expect(
      within(tr).getByRole('combobox', { name: 'Змінити пріоритет наряду НРД-000001' }),
    ).toHaveValue('NORMAL');
  });

  it('закриті статуси — пріоритет лише бейджем, без кнопки зміни', async () => {
    rows = WO_CLOSED_STATUSES.map((s, i) => row(i + 2, s));
    renderPage();
    await waitFor(() => expect(screen.getAllByRole('link').length).toBeGreaterThan(0));
    for (let i = 0; i < WO_CLOSED_STATUSES.length; i++) {
      const tr = tableRow(`НРД-00000${i + 2}`);
      expect(within(tr).getByText('Звичайний')).toBeInTheDocument();
      expect(within(tr).queryByRole('button', { name: /Змінити пріоритет/ })).toBeNull();
    }
  });
});
