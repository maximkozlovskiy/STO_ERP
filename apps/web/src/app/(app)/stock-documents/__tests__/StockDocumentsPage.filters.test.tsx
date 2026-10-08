// Пошук у списку складських документів (рішення власника 2026-10-09): номер або примітка.
//
//   - поле пошуку стоїть у наявному рядку фільтрів ПЕРЕД датами;
//   - пошук іде у фільтр хука лише після debounce; порожній не надсилається;
//   - зміна пошуку повертає на першу сторінку і знімає активне збережене подання;
//   - збережене подання зберігає і відновлює пошук; подання, збережене ДО появи пошуку
//     (без поля `search`), застосовується з порожнім пошуком;
//   - дати за замовчуванням — сьогодні (без змін).
//
// Mutation-verify: прибрати `q` з виклику useStockDocuments, `search` із saveFilter(...) або
// `setSearch(...)` з applyFilter → відповідний кейс падає.

import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';
import { kyivToday } from '@/lib/format';

const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/stock-documents',
}));
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
  useAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: () => Promise.resolve({}) }));

const useStockDocumentsMock = vi.fn();
vi.mock('@/hooks/api/useStockDocuments', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/useStockDocuments')>();
  return {
    ...actual,
    useStockDocuments: (filters: Record<string, unknown>) => {
      useStockDocumentsMock(filters);
      // 3 сторінки по 20 — щоб було з чого скидати пагінацію.
      return { data: { items: [], total: 60, page: 1, limit: 20 }, isLoading: false };
    },
  };
});
vi.mock('../StockMovementsTab', () => ({ StockMovementsTab: () => null }));
vi.mock('@/components/ui/StockDocumentCreateModal', () => ({
  StockDocumentCreateModal: () => null,
}));
vi.mock('@/components/ui/date-picker-input', () => ({
  DatePickerInput: (p: { value: string; onChange: (v: string) => void }) => (
    <input data-testid="date" value={p.value} onChange={e => p.onChange(e.target.value)} />
  ),
}));

import StockDocumentsPage from '../page';

const SEARCH = 'Пошук за номером або приміткою…';
const STORAGE_KEY = 'sto_filters_stock-documents';
const lastFilter = () => useStockDocumentsMock.mock.lastCall![0] as Record<string, unknown>;
const searchInput = () => screen.getByPlaceholderText(SEARCH);
const typeSearch = (value: string) => fireEvent.change(searchInput(), { target: { value } });
const debounce = () => act(() => void vi.advanceTimersByTime(300));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StockDocumentsPage />
    </QueryClientProvider>,
  );
}

describe('Складські документи — пошук', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
    useStockDocumentsMock.mockReset();
    replaceMock.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('за замовчуванням пошук порожній і не надсилається; дати — сьогодні, як і раніше', async () => {
    renderPage();
    await screen.findByPlaceholderText(SEARCH);
    const f = lastFilter();
    expect(f.q).toBeUndefined();
    expect(f.dateFrom).toBe(kyivToday());
    expect(f.dateTo).toBe(kyivToday());
  });

  it('пошук іде у фільтр хука лише після debounce, обрізаний від пробілів', async () => {
    renderPage();
    await screen.findByPlaceholderText(SEARCH);
    typeSearch(' СП-0001 ');
    expect(lastFilter().q).toBeUndefined();
    debounce();
    expect(lastFilter().q).toBe('СП-0001');
  });

  it('зміна пошуку повертає на першу сторінку', async () => {
    renderPage();
    await screen.findByPlaceholderText(SEARCH);
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(lastFilter().page).toBe(2);
    typeSearch('а');
    expect(lastFilter().page).toBe(1);
  });

  it('поле пошуку стоїть у рядку фільтрів після статусів і перед датами', async () => {
    renderPage();
    const search = await screen.findByPlaceholderText(SEARCH);
    const statuses = screen.getByRole('group', { name: 'Статус' });
    const [from, to] = screen.getAllByTestId('date');
    expect(statuses.parentElement!.contains(search)).toBe(true);
    const order = [statuses, search, from!, to!];
    for (let i = 0; i < order.length - 1; i++) {
      expect(
        order[i]!.compareDocumentPosition(order[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('збережене подання зберігає пошук і відновлює його; ручна зміна пошуку знімає подання', async () => {
    renderPage();
    await screen.findByPlaceholderText(SEARCH);
    typeSearch('списання');
    debounce();

    fireEvent.click(screen.getByTitle('Зберегти подання'));
    fireEvent.change(screen.getByPlaceholderText('Назва подання...'), {
      target: { value: 'Моє подання' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти' }));

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Array<{
      filters: Record<string, unknown>;
    }>;
    expect(stored[0]!.filters.search).toBe('списання');

    const preset = screen.getByRole('button', { name: 'Моє подання' });
    expect(preset).toHaveClass('bg-primary');

    // Ручна зміна пошуку — подання вже не відповідає екрану.
    typeSearch('');
    debounce();
    expect(preset).not.toHaveClass('bg-primary');
    expect(lastFilter().q).toBeUndefined();

    fireEvent.click(preset);
    expect(searchInput()).toHaveValue('списання');
    debounce();
    expect(lastFilter().q).toBe('списання');
    expect(preset).toHaveClass('bg-primary');
  });

  it('подання, збережене до появи пошуку (без поля search), очищає пошук, а не лишає старий', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          id: 'old-1',
          name: 'Старе',
          createdAt: 1,
          filters: {
            typeFilter: '',
            statusFilter: 'DRAFT',
            showDeleted: false,
            dateFrom: '',
            dateTo: '',
          },
        },
      ]),
    );
    renderPage();
    await screen.findByPlaceholderText(SEARCH);
    typeSearch('щось');
    debounce();

    fireEvent.click(await screen.findByRole('button', { name: 'Старе' }));
    debounce();
    expect(searchInput()).toHaveValue('');
    expect(lastFilter()).toEqual(expect.objectContaining({ q: undefined, status: 'DRAFT' }));
  });
});
