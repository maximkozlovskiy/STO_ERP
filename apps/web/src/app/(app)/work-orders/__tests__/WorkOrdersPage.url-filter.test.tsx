// Наряди з адреси `?employeeId&employeeName&dateFrom&dateTo` — перехід з рядка механіка у звіті
// «Наряди» (огляд звітів 2026-10-29). Сторінка ставить фільтр виконавця й дати, показує його
// окремою кнопкою-фільтром і прибирає параметри з адреси; «×» або «Мої наряди» фільтр знімає.
//
// Mutation-verify (2026-10-29): не читати employeeId з адреси → падає «фільтр із адреси»; не
// прибирати параметри з адреси → падає «адреса очищена»; «Мої наряди» не знімає фільтр виконавця →
// падає «Мої наряди».
//
// Частина 3 UX-огляду: `?status=` з карток дашборду (кілька статусів → параметр API `statuses`,
// типовий період «сьогодні» знімається) і картка наряду в адресі `?open=<id>` (номер у рядку —
// посилання на картку). Mutation-verify: не ставити статуси з адреси → падає «В роботі»; не знімати
// дати → падає «без дат»; номер без DocLink (span) → падає «клік по номеру».
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import {
  WO_IN_WORK_STATUSES,
  parseWorkOrdersUrlFilter,
  workOrdersFilterHref,
  workOrdersStatusHref,
} from '../url-filter';

const replace = vi.fn();
const push = vi.fn();
const router = { replace, push, back: vi.fn() };
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
// Усі dynamic-компоненти сторінки — заглушки; картка наряду (`open` + `workOrderId`) видима.
vi.mock('next/dynamic', () => ({
  default: () => (p: { open?: boolean; workOrderId?: string }) =>
    p.open && p.workOrderId ? <div data-testid="wo-card">{p.workOrderId}</div> : null,
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
/** Мінімальний рядок списку нарядів для рендеру таблиці. */
function listRow(id: string) {
  return {
    id,
    number: 'НРД-000001',
    status: 'DRAFT',
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
  };
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
      statuses: null,
    });
    const bad = new URLSearchParams('employeeId=abc&dateFrom=20261-10-01&dateTo=2026-10-29');
    expect(parseWorkOrdersUrlFilter(k => bad.get(k))).toEqual({
      executor: null,
      dateFrom: null,
      dateTo: '2026-10-29',
      statuses: null,
    });
    expect(parseWorkOrdersUrlFilter(() => null)).toBeNull();
  });

  it('статуси дашборду: href і розбір; без дат — межі знімаються, невідомий статус відкидається', () => {
    const href = workOrdersStatusHref(WO_IN_WORK_STATUSES);
    expect(href).toBe('/work-orders?status=IN_PROGRESS%2CON_HOLD');
    const q = new URLSearchParams(href.split('?')[1]);
    expect(parseWorkOrdersUrlFilter(k => q.get(k))).toEqual({
      executor: null,
      dateFrom: '',
      dateTo: '',
      statuses: ['IN_PROGRESS', 'ON_HOLD'],
    });
    const withDate = new URLSearchParams('status=COMPLETED,BOGUS&dateFrom=2026-10-01');
    expect(parseWorkOrdersUrlFilter(k => withDate.get(k))).toEqual({
      executor: null,
      dateFrom: '2026-10-01',
      dateTo: null,
      statuses: ['COMPLETED'],
    });
    const bogus = new URLSearchParams('status=BOGUS');
    expect(parseWorkOrdersUrlFilter(k => bogus.get(k))).toBeNull();
  });
});

describe('Наряди — статуси з адреси (картки дашборду)', () => {
  beforeEach(() => {
    replace.mockReset();
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
  });

  it('«В роботі»: запит зі statuses=IN_PROGRESS,ON_HOLD, кнопка-фільтр, адреса очищена', async () => {
    search = 'status=IN_PROGRESS,ON_HOLD';
    renderPage();
    await waitFor(() => expect(lastListQuery().get('statuses')).toBe('IN_PROGRESS,ON_HOLD'));
    expect(lastListQuery().get('status')).toBeNull();
    expect(screen.getByTestId('wo-status-group-filter')).toHaveTextContent(
      'Статус: В роботі, Призупинено',
    );
    expect(replace).toHaveBeenCalledWith('/work-orders', { scroll: false });
  });

  it('без дат в адресі типовий період «сьогодні» знімається — список як на картці', async () => {
    search = 'status=DRAFT,ESTIMATE,APPROVED';
    renderPage();
    await waitFor(() => expect(lastListQuery().get('statuses')).toBe('DRAFT,ESTIMATE,APPROVED'));
    expect(lastListQuery().get('dateFrom')).toBeNull();
    expect(lastListQuery().get('dateTo')).toBeNull();
  });

  it('«×» на фільтрі статусів — усі статуси', async () => {
    search = 'status=IN_PROGRESS,ON_HOLD';
    renderPage();
    await waitFor(() => expect(lastListQuery().get('statuses')).toBe('IN_PROGRESS,ON_HOLD'));
    fireEvent.click(screen.getByTestId('wo-status-group-filter'));
    await waitFor(() => expect(lastListQuery().get('statuses')).toBeNull());
    expect(lastListQuery().get('status')).toBeNull();
  });
});

describe('Наряди — картка в адресі (?open=)', () => {
  const WO = '33333333-3333-4333-8333-333333333333';
  beforeEach(() => {
    replace.mockReset();
    push.mockReset();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).startsWith('/work-orders?')
          ? { items: [listRow(WO)], total: 1, page: 1, limit: 20 }
          : {},
      ),
    );
  });

  it('посилання ?open=<id> відкриває картку наряду, адресу не чистить', async () => {
    search = `open=${WO}`;
    renderPage();
    expect(await screen.findByTestId('wo-card')).toHaveTextContent(WO);
    expect(replace).not.toHaveBeenCalled();
  });

  it('клік по номеру — картка в адресі (новий запис історії), не бічна панель', async () => {
    search = '';
    renderPage();
    const link = await screen.findByRole('link', { name: 'НРД-000001' });
    expect(link).toHaveAttribute('href', `/work-orders?open=${WO}`);
    fireEvent.click(link);
    expect(push).toHaveBeenCalledWith(`/work-orders?open=${WO}`, { scroll: false });
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
