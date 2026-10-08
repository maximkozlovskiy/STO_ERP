// Пошук на вкладці «Рухи» складу (рішення власника 2026-10-09): назва або артикул товару.
//
//   - поле пошуку стоїть перед датами;
//   - пошук іде у фільтр хука лише після debounce; порожній не надсилається;
//   - зміна пошуку повертає на першу сторінку; «Скинути» чистить і пошук;
//   - дати за замовчуванням лишились порожніми (без змін).
//
// Mutation-verify: прибрати `q` з `filters` або `debouncedSearch` із залежностей useMemo → падає.

import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/format', () => ({
  fmtMoney: (v: number) => String(v),
  fmtDateTime: (v: string) => v,
}));
vi.mock('@/hooks/api/useInfrastructure', () => ({
  useWarehouses: () => ({ data: [{ id: 'w1', name: 'Головний' }] }),
}));

const useStockMovementsMock = vi.fn();
vi.mock('@/hooks/api/useInventory', () => ({
  useStockMovements: (...a: unknown[]) => useStockMovementsMock(...a),
}));

import { StockMovementsTab } from '../StockMovementsTab';

const SEARCH = 'Пошук за товаром або артикулом…';
const lastFilter = () => useStockMovementsMock.mock.lastCall![0] as Record<string, unknown>;
const typeSearch = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText(SEARCH), { target: { value } });
const debounce = () => act(() => void vi.advanceTimersByTime(300));

describe('StockMovementsTab — пошук', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStockMovementsMock.mockReset();
    // 3 сторінки по 50.
    useStockMovementsMock.mockReturnValue({
      data: { items: [], total: 150, page: 1, limit: 50 },
      isLoading: false,
      isFetching: false,
    });
  });
  afterEach(() => vi.useRealTimers());

  it('за замовчуванням пошук і дати порожні й у запит не йдуть', () => {
    render(<StockMovementsTab />);
    const f = lastFilter();
    expect(f.q).toBeUndefined();
    expect(f.from).toBeUndefined();
    expect(f.to).toBeUndefined();
  });

  it('пошук іде у фільтр хука лише після debounce, обрізаний від пробілів', () => {
    render(<StockMovementsTab />);
    typeSearch(' OIL-1 ');
    expect(lastFilter().q).toBeUndefined();
    debounce();
    expect(lastFilter().q).toBe('OIL-1');
  });

  it('зміна пошуку повертає на першу сторінку', () => {
    render(<StockMovementsTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Далі' }));
    expect(lastFilter().page).toBe(2);
    typeSearch('олива');
    expect(lastFilter().page).toBe(1);
  });

  it('«Скинути» з’являється від самого пошуку і чистить його', () => {
    render(<StockMovementsTab />);
    expect(screen.queryByRole('button', { name: 'Скинути' })).not.toBeInTheDocument();
    typeSearch('олива');
    debounce();
    fireEvent.click(screen.getByRole('button', { name: 'Скинути' }));
    debounce();
    expect(screen.getByPlaceholderText(SEARCH)).toHaveValue('');
    expect(lastFilter().q).toBeUndefined();
  });

  it('поле пошуку стоїть перед датами, у тому самому рядку фільтрів', () => {
    const { container } = render(<StockMovementsTab />);
    const search = screen.getByPlaceholderText(SEARCH);
    const [from, to] = Array.from(container.querySelectorAll('input[type="date"]'));
    expect(from && to).toBeTruthy();
    expect(search.closest('div.flex-wrap')!.contains(from!)).toBe(true);
    expect(search.compareDocumentPosition(from!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(from!.compareDocumentPosition(to!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Bug #816: довший за 100 символів `q` бекенд або відхиляє (400), або мовчки обрізає — поле
  // не дає ввести більше, ніж буде знайдено.
  it('поле пошуку обмежене 100 символами — межа бекенду', () => {
    render(<StockMovementsTab />);
    expect(screen.getByPlaceholderText(SEARCH)).toHaveAttribute('maxlength', '100');
  });
});
