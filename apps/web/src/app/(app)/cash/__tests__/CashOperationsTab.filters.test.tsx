// Пошук і відбір за датою у вкладці «Операції» каси (рішення власника 2026-10-09).
//
//   - рядок «пошук · З · По» стоїть над списком операцій;
//   - дати за замовчуванням — СЬОГОДНІ (київський день, kyivToday), а не вся історія каси;
//   - пошук іде у фільтр хука лише після debounce; порожні значення не надсилаються;
//   - список каси не має пагінації (GET /cash-registers/:id/operations віддає масив), тож
//     «скидання сторінки» тут немає чого перевіряти.
//
// Mutation-verify: не передавати `opsFilter` у useCashOperations або замінити kyivToday() на ''
// → відповідний кейс падає.

import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';

const TODAY = '2026-10-09';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/format', () => ({
  fmtMoney: (v: number) => String(v),
  fmtDateTime: (v: string) => v,
  kyivToday: () => '2026-10-09',
}));
vi.mock('@/components/ui/date-picker-input', () => ({
  DatePickerInput: (p: {
    value: string;
    onChange: (v: string) => void;
    min?: string;
    max?: string;
  }) => (
    <input
      data-testid="date"
      value={p.value}
      data-min={p.min ?? ''}
      data-max={p.max ?? ''}
      onChange={e => p.onChange(e.target.value)}
    />
  ),
}));

const useCashOperationsMock = vi.fn();
vi.mock('@/hooks/api/useCash', () => ({
  useCashRegisters: () => ({
    data: [
      {
        id: 'reg-1',
        name: 'Каса №1',
        branchId: 'br-1',
        currencyCode: 'UAH',
        currencySymbol: '₴',
        isFiscal: false,
        initialBalance: 0,
        balance: 0,
      },
    ],
    isLoading: false,
  }),
  useCashOperations: (...a: unknown[]) => useCashOperationsMock(...a),
  useCreateCashOperation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
  CASH_REASON_LABELS: {},
  MANUAL_IN_REASONS: ['MANUAL_IN'],
  MANUAL_OUT_REASONS: ['MANUAL_OUT'],
}));
vi.mock('@/hooks/api/useExpenseCategories', () => ({
  useExpenseCategories: () => ({ data: [] }),
  flattenActiveByType: () => [],
}));
vi.mock('@/hooks/api/useCashShift', () => ({
  useCurrentShift: () => ({ data: null, isLoading: false }),
  useOpenShift: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCloseShift: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import CashOperationsTab from '../CashOperationsTab';

const SEARCH = 'Пошук за приміткою або статтею…';
// Останній виклик ДЛЯ ОБРАНОЇ каси: до автовибору першої каси хук кличеться з null.
const lastCall = () =>
  useCashOperationsMock.mock.lastCall as [string | null, Record<string, unknown>];
const typeSearch = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText(SEARCH), { target: { value } });
const debounce = () => act(() => void vi.advanceTimersByTime(300));
const dates = () => screen.getAllByTestId('date') as HTMLInputElement[];

describe('CashOperationsTab — пошук і дати', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useCashOperationsMock.mockReset();
    useCashOperationsMock.mockReturnValue({ data: [], isLoading: false });
  });
  afterEach(() => vi.useRealTimers());

  it('за замовчуванням період — сьогодні, і він іде у запит операцій обраної каси', () => {
    render(<CashOperationsTab />);
    expect(dates().map(d => d.value)).toEqual([TODAY, TODAY]);
    const [registerId, filter] = lastCall();
    expect(registerId).toBe('reg-1');
    expect(filter).toEqual({ q: undefined, dateFrom: TODAY, dateTo: TODAY });
  });

  it('пошук іде у фільтр хука лише після debounce, обрізаний від пробілів', () => {
    render(<CashOperationsTab />);
    typeSearch(' оренда  ');
    expect(lastCall()[1].q).toBeUndefined();
    debounce();
    expect(lastCall()[1].q).toBe('оренда');
  });

  it('зміна дат іде у фільтр; очищена дата не надсилається', () => {
    render(<CashOperationsTab />);
    fireEvent.change(dates()[0]!, { target: { value: '2026-10-01' } });
    expect(lastCall()[1]).toEqual(
      expect.objectContaining({ dateFrom: '2026-10-01', dateTo: TODAY }),
    );
    expect(dates()[1]!.dataset.min).toBe('2026-10-01');
    expect(dates()[0]!.dataset.max).toBe(TODAY);

    fireEvent.change(dates()[1]!, { target: { value: '' } });
    expect(lastCall()[1].dateTo).toBeUndefined();
  });

  it('рядок «пошук · З · По» стоїть над таблицею операцій', () => {
    render(<CashOperationsTab />);
    const search = screen.getByPlaceholderText(SEARCH);
    const row = search.closest('div.flex-wrap')!;
    const [from, to] = dates();
    expect(row.contains(from!)).toBe(true);
    expect(row.contains(to!)).toBe(true);
    expect(search.compareDocumentPosition(from!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(from!.compareDocumentPosition(to!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      row.compareDocumentPosition(screen.getByRole('table')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('порожній список за фільтром не закликає «внести або видати» — каже, що за періодом порожньо', () => {
    render(<CashOperationsTab />);
    expect(
      screen.getByText('За обраним періодом і пошуком операцій не знайдено'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Внесіть або видайте готівку')).not.toBeInTheDocument();
  });

  // Bug #816: довший за 100 символів `q` бекенд або відхиляє (400), або мовчки обрізає — поле
  // не дає ввести більше, ніж буде знайдено.
  it('поле пошуку обмежене 100 символами — межа бекенду', () => {
    render(<CashOperationsTab />);
    expect(screen.getByPlaceholderText(SEARCH)).toHaveAttribute('maxlength', '100');
  });
});
