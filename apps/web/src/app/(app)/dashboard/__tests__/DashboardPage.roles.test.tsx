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
let streamData: Record<string, unknown> | null = null;
vi.mock('@/hooks/useDashboardStream', () => ({
  useDashboardStream: () => ({ data: streamData, isLive: false }),
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
  [/^\/calendar\/slots/, ['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC']],
  [/^\/lifts/, ['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC']],
];

let orders: unknown[] = [];
let invoices: unknown[] = [];
/** `total` відповіді списку, коли сервер має більше за віддані `items` (null — `items.length`). */
let ordersTotal: number | null = null;
let invoicesTotal: number | null = null;

function fakeApi(path: string) {
  const rule = ALLOWED.find(([re]) => re.test(path));
  if (rule && !rule[1].includes(role)) return Promise.reject(new Error('403 Forbidden'));
  if (path.startsWith('/work-orders')) {
    return Promise.resolve({ items: orders, total: ordersTotal ?? orders.length });
  }
  if (path.startsWith('/invoices'))
    return Promise.resolve({ items: invoices, total: invoicesTotal ?? invoices.length });
  if (path.startsWith('/reports/revenue')) return Promise.resolve({ rows: [] });
  if (path.startsWith('/tasks')) return Promise.resolve({ items: [], total: 0 });
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

/** Значення й підпис тренду картки показника за її назвою (розмітка `KpiCard`). */
function kpi(label: string) {
  const value = screen.getByText(label).nextElementSibling;
  const norm = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();
  return { value: norm(value?.textContent), trend: norm(value?.nextElementSibling?.textContent) };
}

function resetData() {
  streamData = null;
  ordersTotal = null;
  invoicesTotal = null;
  orders = [{ status: 'IN_PROGRESS', completedAt: null }];
  invoices = [{ amount: 100 }];
}

describe('Дашборд — запити лише дозволені ролі (Bug #879)', () => {
  beforeEach(() => {
    resetData();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((p: string) => fakeApi(p));
  });

  it('механік: лише наряди; картки показників без банера помилки, недоступні — «—»', async () => {
    role = 'MECHANIC';
    renderPage();
    expect(await screen.findByText('В роботі')).toBeInTheDocument();
    // Наряди й календар (підсумки місяця, BR-CAL-013) — більше нічого.
    await waitFor(() => expect(requested().some(p => p.startsWith('/calendar/slots'))).toBe(true));
    const calendarOnly = /^\/(work-orders|calendar\/slots|lifts|tasks|settings\/work-hours)/;
    expect(requested().filter(p => !calendarOnly.test(p))).toEqual([]);
    expect(screen.queryByText(/Не вдалося завантажити/)).not.toBeInTheDocument();
    expect(screen.queryByText('Немає даних')).not.toBeInTheDocument();
    // Рахунки, склад і виручка механіку не віддаються — не «0», а «—».
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('приймальня: без складу й виручки, решта — запитується', async () => {
    role = 'RECEPTIONIST';
    renderPage();
    expect(await screen.findByText('В роботі')).toBeInTheDocument();
    await waitFor(() => expect(requested().some(p => p.startsWith('/calendar/slots'))).toBe(true));
    const paths = requested();
    expect(paths.some(p => p.startsWith('/stock-items'))).toBe(false);
    expect(paths.some(p => p.startsWith('/reports'))).toBe(false);
    expect(paths.some(p => p.startsWith('/invoices'))).toBe(true);
    expect(paths.some(p => p.startsWith('/maintenance-schedules'))).toBe(true);
    expect(screen.queryByText(/Не вдалося завантажити/)).not.toBeInTheDocument();
  });

  it('власник: усі пʼять списків і календар; запиту гарантій немає', async () => {
    role = 'OWNER';
    renderPage();
    expect(await screen.findByText('В роботі')).toBeInTheDocument();
    const prefixes = [
      '/work-orders',
      '/stock-items/low',
      '/invoices',
      '/reports/revenue',
      '/maintenance-schedules/upcoming',
      '/calendar/slots?from=',
      '/lifts',
      '/tasks',
    ];
    await waitFor(() =>
      expect(prefixes.filter(pre => !requested().some(p => p.startsWith(pre)))).toEqual([]),
    );
    expect(requested().some(p => p.startsWith('/warranties'))).toBe(false);
    expect(await screen.findByTestId('dashboard-calendar-summary')).toBeInTheDocument();
  });

  // guards: BR-CAL-013
  it('бухгалтер: без календаря — ні запитів записів і підйомників, ні картки', async () => {
    role = 'ACCOUNTANT';
    renderPage();
    expect(await screen.findByText('В роботі')).toBeInTheDocument();
    await waitFor(() => expect(requested().some(p => p.startsWith('/invoices'))).toBe(true));
    expect(requested().some(p => /^\/(calendar|lifts)/.test(p))).toBe(false);
    expect(screen.queryByTestId('dashboard-calendar-summary')).not.toBeInTheDocument();
    expect(screen.queryByText(/Не вдалося завантажити/)).not.toBeInTheDocument();
  });
});

describe('Дашборд — показники (TECH-DEBT §8, §10 п. 26)', () => {
  beforeEach(() => {
    resetData();
    role = 'OWNER';
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((p: string) => fakeApi(p));
  });

  it('«Оплати сьогодні»: null від сервера (підзапит не встиг) → «—», а не 0', async () => {
    streamData = {
      activeWo: null,
      todayRevenue: null,
      pendingInvoices: null,
      lowStockCount: null,
      timestamp: 'x',
    };
    renderPage();
    expect(await screen.findByText('Оплати сьогодні')).toBeInTheDocument();
    expect(kpi('Оплати сьогодні').value).toBe('—');
    // Решта null-полів — запасні значення зі списків web, а не «0» сервера.
    expect(kpi('В роботі').value).toBe('1');
    expect(kpi('Несплачені рахунки').value).toBe('1');
  });

  it('«Оплати сьогодні»: 0 від сервера — справжній нуль, «0,00 ₴»', async () => {
    streamData = {
      activeWo: 0,
      todayRevenue: 0,
      pendingInvoices: 0,
      lowStockCount: 0,
      timestamp: 'x',
    };
    renderPage();
    expect(await screen.findByText('Оплати сьогодні')).toBeInTheDocument();
    expect(kpi('Оплати сьогодні').value).toBe('0,00 ₴');
  });

  it('«завершено сьогодні» не рахує наряд, скасований після завершення', async () => {
    const now = new Date().toISOString();
    orders = [
      { status: 'COMPLETED', completedAt: now },
      { status: 'CANCELLED', completedAt: now },
    ];
    renderPage();
    expect(await screen.findByText('В роботі')).toBeInTheDocument();
    expect(kpi('В роботі').trend).toBe('↑ 1 завершено сьогодні');
  });

  it('запасний шлях: усі неоплачені статуси; сума — залишки, без повністю віддзеркалених', async () => {
    invoices = [
      { amount: 100, paidAmount: 100 }, // чернетка, віддзеркалена з оплаченого наряду — боргу 0
      { amount: 300, paidAmount: 120.5 }, // частково оплачений — до сплати 179,50
      { amount: 50 }, // без paidAmount у відповіді — увесь
    ];
    renderPage();
    expect(await screen.findByText('Несплачені рахунки')).toBeInTheDocument();
    expect(requested()).toContain('/invoices?statuses=DRAFT,SENT,PARTIALLY_PAID,OVERDUE&limit=200');
    expect(kpi('Несплачені рахунки')).toEqual({ value: '2', trend: '↓ 229,50 ₴' });
  });

  // Bug #987: запасне «В роботі» — ті самі статуси, що `activeWo` сервера (IN_PROGRESS + ON_HOLD);
  // список, урізаний `limit=200` (total > items), — не точне число, а «—».
  // Mutation-verify: фільтр лише `IN_PROGRESS` → перший кейс «1» замість «2»; прибрати
  // `!ordersPartial` / `!invoicesPartial` → другий кейс показує «2» / «1» і суму.
  it('запасне «В роботі»: у роботі й на паузі, як лічильник сервера', async () => {
    orders = [
      { status: 'IN_PROGRESS', completedAt: null },
      { status: 'ON_HOLD', completedAt: null },
      { status: 'DRAFT', completedAt: null },
    ];
    streamData = {
      activeWo: null,
      todayRevenue: 0,
      pendingInvoices: null,
      lowStockCount: 0,
      timestamp: 'x',
    };
    renderPage();
    expect(await screen.findByText('В роботі')).toBeInTheDocument();
    expect(kpi('В роботі').value).toBe('2');
  });

  it('запасні лічильники з урізаного списку (total > items) — «—», не часткове число', async () => {
    orders = [
      { status: 'IN_PROGRESS', completedAt: null },
      { status: 'ON_HOLD', completedAt: null },
    ];
    ordersTotal = 878;
    invoices = [{ amount: 100 }];
    invoicesTotal = 878;
    streamData = {
      activeWo: null,
      todayRevenue: 0,
      pendingInvoices: null,
      lowStockCount: 0,
      timestamp: 'x',
    };
    renderPage();
    expect(await screen.findByText('Несплачені рахунки')).toBeInTheDocument();
    // Показникам потрібні наряди й рахунки (календар дашборду шле свої запити окремо).
    await waitFor(() =>
      expect(
        ['/work-orders', '/invoices'].every(pre => requested().some(p => p.startsWith(pre))),
      ).toBe(true),
    );
    expect(kpi('В роботі').value).toBe('—');
    expect(kpi('Несплачені рахунки')).toEqual({ value: '—', trend: '' });
  });
});
