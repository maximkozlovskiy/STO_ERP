// Наряди з адреси `?employeeId&employeeName&dateFrom&dateTo` — перехід з рядка механіка у звіті
// «Наряди» (огляд звітів 2026-10-29). Сторінка ставить фільтр виконавця й дати, показує його
// окремою кнопкою-фільтром і прибирає параметри з адреси; «×» або «Мої наряди» фільтр знімає.
//
// Mutation-verify (2026-10-29): не читати employeeId з адреси → падає «фільтр із адреси»; не
// прибирати параметри з адреси → падає «адреса очищена»; «Мої наряди» не знімає фільтр виконавця →
// падає «Мої наряди».
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { parseWorkOrdersUrlFilter, workOrdersFilterHref } from '../url-filter';

const replace = vi.fn();
const router = { replace, push: vi.fn() };
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => '/work-orders',
}));
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'me', role: 'OWNER' } }),
  useAuth: () => ({ employee: { id: 'me', role: 'OWNER' } }),
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
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

import WorkOrdersPage from '../page';

const MECH = '11111111-1111-4111-8111-111111111111';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WorkOrdersPage />
    </QueryClientProvider>,
  );
}
/** Параметри останнього запиту списку нарядів. */
const lastListQuery = () => {
  const calls = apiFetchMock.mock.calls.filter(c => String(c[0]).startsWith('/work-orders?'));
  const url = String(calls.at(-1)?.[0] ?? '');
  return new URLSearchParams(url.slice(url.indexOf('?') + 1));
};

describe('url-filter — розбір і побудова адреси', () => {
  it('href і розбір — взаємно обернені; невалідний id чи дата ігноруються', () => {
    const href = workOrdersFilterHref(
      { id: MECH, name: 'Петренко Іван' },
      '2026-10-01',
      '2026-10-29',
    );
    const q = new URLSearchParams(href.split('?')[1]);
    expect(parseWorkOrdersUrlFilter(k => q.get(k))).toEqual({
      executor: { id: MECH, name: 'Петренко Іван' },
      dateFrom: '2026-10-01',
      dateTo: '2026-10-29',
    });
    const bad = new URLSearchParams('employeeId=abc&dateFrom=20261-10-01&dateTo=2026-10-29');
    expect(parseWorkOrdersUrlFilter(k => bad.get(k))).toEqual({
      executor: null,
      dateFrom: null,
      dateTo: '2026-10-29',
    });
    expect(parseWorkOrdersUrlFilter(() => null)).toBeNull();
  });
});

describe('Наряди — фільтр виконавця з адреси (звіт «Наряди»)', () => {
  beforeEach(() => {
    replace.mockReset();
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
    search = new URLSearchParams({
      employeeId: MECH,
      employeeName: 'Петренко Іван',
      dateFrom: '2026-10-01',
      dateTo: '2026-10-29',
    }).toString();
  });

  it('фільтр із адреси: запит з employeeId і датами, кнопка-фільтр з іменем, адреса очищена', async () => {
    renderPage();
    await waitFor(() => expect(lastListQuery().get('employeeId')).toBe(MECH));
    expect(lastListQuery().get('dateFrom')).toBe('2026-10-01');
    expect(lastListQuery().get('dateTo')).toBe('2026-10-29');
    expect(screen.getByTestId('wo-executor-filter')).toHaveTextContent('Виконавець: Петренко Іван');
    expect(replace).toHaveBeenCalledWith('/work-orders', { scroll: false });
  });

  it('«×» на фільтрі знімає виконавця, дати лишаються', async () => {
    renderPage();
    await waitFor(() => expect(lastListQuery().get('employeeId')).toBe(MECH));
    fireEvent.click(
      screen.getByRole('button', { name: 'Зняти фільтр «Виконавець: Петренко Іван»' }),
    );
    await waitFor(() => expect(lastListQuery().get('employeeId')).toBeNull());
    expect(lastListQuery().get('dateFrom')).toBe('2026-10-01');
    expect(screen.queryByTestId('wo-executor-filter')).toBeNull();
  });

  it('«Мої наряди» замінює фільтр виконавця на свого працівника', async () => {
    renderPage();
    await waitFor(() => expect(lastListQuery().get('employeeId')).toBe(MECH));
    fireEvent.click(screen.getByRole('button', { name: 'Мої наряди' }));
    await waitFor(() => expect(lastListQuery().get('employeeId')).toBe('me'));
    expect(screen.queryByTestId('wo-executor-filter')).toBeNull();
  });

  it('без параметрів фільтра адреса не чіпається', async () => {
    search = 'tab=workOrders';
    renderPage();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(replace).not.toHaveBeenCalled();
    expect(lastListQuery().get('employeeId')).toBeNull();
  });
});
