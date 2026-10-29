// Картки дашборду ведуть у відфільтрований список (UX-огляд 2026-10-29, частина 3): «В роботі» і
// «Очікують» — у наряди з тими самими статусами, що рахує картка; «Новий наряд» / «Новий клієнт» —
// одразу у форму створення, а не в список. Вибір швидких дій зберігається за старим `href`, тож
// збережені налаштування користувача лишаються робочими.
//
// Mutation-verify (2026-10-29): «В роботі» → `href="/work-orders"` → падає «В роботі»; лічильник
// «В роботі» без ON_HOLD → падає «той самий набір»; `href={href}` у швидких діях → падає «форма».
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { WO_EDITABLE_STATUSES } from '@sto/shared';
import { WO_IN_WORK_STATUSES, parseWorkOrdersUrlFilter } from '../../work-orders/url-filter';

vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'e1', role: 'OWNER', firstName: 'Тест' } }),
  useAuth: () => ({ employee: { id: 'e1', role: 'OWNER', firstName: 'Тест' } }),
}));
vi.mock('@/hooks/useDashboardStream', () => ({
  useDashboardStream: () => ({ data: null, isLive: false }),
}));
vi.mock('../RevenueChart', () => ({ default: () => null }));

const ORDERS = [
  'DRAFT',
  'ESTIMATE',
  'APPROVED',
  'APPROVED',
  'IN_PROGRESS',
  'ON_HOLD',
  'ON_HOLD',
  'COMPLETED',
  'PAID',
].map((status, i) => ({ id: `wo-${i}`, status, completedAt: null }));

vi.mock('@/lib/api-client', () => ({
  apiFetch: (path: string) => {
    if (path.startsWith('/work-orders'))
      return Promise.resolve({ items: ORDERS, total: ORDERS.length });
    if (path.startsWith('/invoices')) return Promise.resolve({ items: [], total: 0 });
    if (path.startsWith('/reports/revenue')) return Promise.resolve({ rows: [] });
    if (path.startsWith('/reports/pnl'))
      return Promise.resolve({ rows: [], payrollMissingMonths: [] });
    if (path.startsWith('/tasks')) return Promise.resolve({ items: [], total: 0 });
    return Promise.resolve([]);
  },
}));

import DashboardPage from '../page';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DashboardPage />
    </QueryClientProvider>,
  );
}

/** Посилання картки показника за її назвою. */
const kpiLink = (label: string) => screen.getByText(label).closest('a');
const statusesOf = (href: string) => {
  const q = new URLSearchParams(href.split('?')[1]);
  return parseWorkOrdersUrlFilter(k => q.get(k))?.statuses ?? null;
};

describe('дашборд — посилання карток', () => {
  beforeEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('«В роботі» → наряди IN_PROGRESS + ON_HOLD, число на картці = кількість таких нарядів', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('В роботі')).toBeInTheDocument());
    const href = kpiLink('В роботі')?.getAttribute('href') ?? '';
    expect(statusesOf(href)).toEqual(['IN_PROGRESS', 'ON_HOLD']);
    // той самий набір: картка рахує рівно ті статуси, які відбирає список
    const expected = ORDERS.filter(o => WO_IN_WORK_STATUSES.includes(o.status)).length;
    await waitFor(() =>
      expect(kpiLink('В роботі')).toHaveTextContent(new RegExp(`В роботі\\s*${expected}`)),
    );
  });

  it('«Очікують» → наряди DRAFT + ESTIMATE + APPROVED', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Очікують')).toBeInTheDocument());
    const href = kpiLink('Очікують')?.getAttribute('href') ?? '';
    expect(statusesOf(href)).toEqual([...WO_EDITABLE_STATUSES]);
    const expected = ORDERS.filter(o => WO_EDITABLE_STATUSES.includes(o.status)).length;
    await waitFor(() =>
      expect(kpiLink('Очікують')).toHaveTextContent(new RegExp(`Очікують\\s*${expected}`)),
    );
  });

  it('швидкі дії «Новий наряд» / «Новий клієнт» відкривають форму створення', async () => {
    renderPage();
    const wo = await screen.findByRole('link', { name: 'Новий наряд' });
    expect(wo).toHaveAttribute('href', '/work-orders?action=new');
    expect(screen.getByRole('link', { name: 'Новий клієнт' })).toHaveAttribute(
      'href',
      '/counterparties?action=new',
    );
  });

  it('збережений вибір швидких дій (за старим href) працює', async () => {
    window.localStorage.setItem('sto_quick_actions', JSON.stringify(['/work-orders']));
    renderPage();
    expect(await screen.findByRole('link', { name: 'Новий наряд' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Новий клієнт' })).toBeNull();
  });
});
