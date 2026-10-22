// Сторінка «Наряди»: вкладки «Наряди» / «Гарантії» (BR-WAR-005, рішення власника 2026-10-22).
// Вкладка в URL (`?tab=warranties`); бачать її ролі `GET /warranties`, механік — лише наряди;
// «Звернення» вкладка отримує лише для ролей `POST /warranties/:id/claim`.

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const replace = vi.fn();
const router = { replace, push: vi.fn() };
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => '/work-orders',
}));
let role = 'OWNER';
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'e1', role } }),
  useAuth: () => ({ employee: { id: 'e1', role } }),
}));
// Обидві ліниві частини сторінки (картка наряду, вкладка «Гарантії») — заглушки: тут перевіряється
// лише, ЯКА вкладка показана і з якими правами.
vi.mock('next/dynamic', () => ({
  default: () => (p: { canClaim?: boolean }) =>
    'canClaim' in p ? (
      <div data-testid="warranties-tab" data-can-claim={String(p.canClaim)} />
    ) : null,
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

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WorkOrdersPage />
    </QueryClientProvider>,
  );
}

const warrantiesTab = () => screen.queryByTestId('warranties-tab');
const workOrdersRequested = () =>
  apiFetchMock.mock.calls.some(c => String(c[0]).startsWith('/work-orders?'));

describe('Наряди — вкладки «Наряди» / «Гарантії»', () => {
  beforeEach(() => {
    search = '';
    role = 'OWNER';
    replace.mockReset();
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
  });

  // guards: BR-WAR-005
  it('без параметра — вкладка «Наряди» (список нарядів), «Гарантії» — поряд', async () => {
    renderPage();

    expect(screen.getByRole('tab', { name: 'Наряди' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Гарантії' })).toHaveAttribute('aria-selected', 'false');
    expect(warrantiesTab()).toBeNull();
    await waitFor(() => expect(workOrdersRequested()).toBe(true));
  });

  // guards: BR-WAR-005
  it('клік «Гарантії» пише вкладку в URL; «Наряди» — прибирає', () => {
    renderPage();

    fireEvent.click(screen.getByRole('tab', { name: 'Гарантії' }));
    expect(replace).toHaveBeenLastCalledWith('/work-orders?tab=warranties', { scroll: false });
    fireEvent.click(screen.getByRole('tab', { name: 'Наряди' }));
    expect(replace).toHaveBeenLastCalledWith('/work-orders', { scroll: false });
  });

  // guards: BR-WAR-005
  it('?tab=warranties — вкладка «Гарантії» замість списку нарядів; власник може звертатись', () => {
    search = 'tab=warranties';
    renderPage();

    expect(screen.getByRole('tab', { name: 'Гарантії' })).toHaveAttribute('aria-selected', 'true');
    expect(warrantiesTab()).toHaveAttribute('data-can-claim', 'true');
    expect(workOrdersRequested()).toBe(false);
  });

  // guards: BR-WAR-005
  it('бухгалтер бачить вкладку, але без «Звернення»', () => {
    search = 'tab=warranties';
    role = 'ACCOUNTANT';
    renderPage();

    expect(warrantiesTab()).toHaveAttribute('data-can-claim', 'false');
  });

  // guards: BR-WAR-005
  it('механік: вкладок немає, за посиланням ?tab=warranties — список нарядів і чиста адреса', async () => {
    search = 'tab=warranties';
    role = 'MECHANIC';
    renderPage();

    expect(screen.queryByRole('tablist')).toBeNull();
    expect(warrantiesTab()).toBeNull();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/work-orders', { scroll: false }));
    await waitFor(() => expect(workOrdersRequested()).toBe(true));
  });
});
