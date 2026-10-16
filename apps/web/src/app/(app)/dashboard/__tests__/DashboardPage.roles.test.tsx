// Bug #879: дашборд механіка й приймальні показував банер помилки й «Немає даних», бо слав запити
// до списків, які їхня роль не читає (403 → isError, kpi = null). Тепер запити — лише дозволені,
// показники без доступу — «—», а картки показників рендеряться.
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

let role = 'MECHANIC';
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'e1', role, firstName: 'Тест' } }),
  useAuth: () => ({ employee: { id: 'e1', role, firstName: 'Тест' } }),
}));
vi.mock('@/hooks/useDashboardStream', () => ({
  useDashboardStream: () => ({ data: null, isLive: false }),
}));
vi.mock('../RevenueChart', () => ({ default: () => null }));

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

/** Ролі ендпоінтів — як `@Roles` api; інша роль отримує 403, як на сервері. */
const ALLOWED: [RegExp, string[]][] = [
  [/^\/work-orders\?/, ['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT']],
  [/^\/stock-items\/low/, ['OWNER', 'ADMIN', 'STOREKEEPER']],
  [/^\/invoices\?/, ['OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST']],
  [/^\/reports\/revenue/, ['OWNER', 'ADMIN', 'ACCOUNTANT']],
  [/^\/maintenance-schedules\/upcoming/, ['OWNER', 'ADMIN', 'RECEPTIONIST']],
  [/^\/warranties\/expiring/, ['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT']],
];

function fakeApi(path: string) {
  const rule = ALLOWED.find(([re]) => re.test(path));
  if (rule && !rule[1].includes(role)) return Promise.reject(new Error('403 Forbidden'));
  if (path.startsWith('/work-orders')) {
    return Promise.resolve({ items: [{ status: 'IN_PROGRESS', completedAt: null }], total: 1 });
  }
  if (path.startsWith('/invoices')) return Promise.resolve({ items: [{ amount: 100 }], total: 1 });
  if (path.startsWith('/reports/revenue')) return Promise.resolve({ rows: [] });
  if (path.startsWith('/warranties')) return Promise.resolve({ items: [], total: 0 });
  return Promise.resolve([]);
}

import DashboardPage from '../page';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DashboardPage />
    </QueryClientProvider>,
  );
}

const requested = () => apiFetchMock.mock.calls.map(c => String(c[0]));

describe('Дашборд — запити лише дозволені ролі (Bug #879)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((p: string) => fakeApi(p));
  });

  it('механік: лише наряди; картки показників без банера помилки, недоступні — «—»', async () => {
    role = 'MECHANIC';
    renderPage();
    expect(await screen.findByText('В роботі')).toBeInTheDocument();
    expect(requested().filter(p => !p.startsWith('/work-orders'))).toEqual([]);
    expect(screen.queryByText(/Не вдалося завантажити/)).not.toBeInTheDocument();
    expect(screen.queryByText('Немає даних')).not.toBeInTheDocument();
    // Рахунки, склад і виручка механіку не віддаються — не «0», а «—».
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('приймальня: без складу й виручки, решта — запитується', async () => {
    role = 'RECEPTIONIST';
    renderPage();
    expect(await screen.findByText('В роботі')).toBeInTheDocument();
    await waitFor(() => expect(requested().some(p => p.startsWith('/warranties'))).toBe(true));
    const paths = requested();
    expect(paths.some(p => p.startsWith('/stock-items'))).toBe(false);
    expect(paths.some(p => p.startsWith('/reports'))).toBe(false);
    expect(paths.some(p => p.startsWith('/invoices'))).toBe(true);
    expect(paths.some(p => p.startsWith('/maintenance-schedules'))).toBe(true);
    expect(screen.queryByText(/Не вдалося завантажити/)).not.toBeInTheDocument();
  });

  it('власник: усі шість списків', async () => {
    role = 'OWNER';
    renderPage();
    expect(await screen.findByText('В роботі')).toBeInTheDocument();
    await waitFor(() => expect(requested()).toHaveLength(6));
  });
});
