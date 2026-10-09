// Пошук і відбір за датою на вкладці банківських платежів (рішення власника 2026-10-09).
//
//   - рядок «пошук · З · По» стоїть МІЖ фільтрами статусу й таблицею, «Імпорт виписки» — у ньому
//     праворуч;
//   - дати за замовчуванням ПОРОЖНІ: виписку імпортують за минулі дні, нерознесені рядки мають
//     бути на виду без вибору періоду;
//   - пошук іде у фільтр хука лише після debounce; порожні значення не надсилаються;
//   - зміна пошуку чи дати повертає на першу сторінку.
//
// Mutation-verify: прибрати `q` / `dateFrom` / `dateTo` з виклику useBankTransactions або
// `setPage(1)` з обробників → відповідний кейс падає.

import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/format', () => ({
  fmtMoney: (v: number) => String(v),
  fmtDate: (v: string) => v,
  fmtBankCurrencySuffix: () => '₴',
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/MatchBankTransactionModal', () => ({
  MatchBankTransactionModal: () => null,
}));
vi.mock('@/components/ui/BankStatementImportModal', () => ({
  BankStatementImportModal: () => null,
}));
vi.mock('@/components/ui/MatchOutgoingBankTransactionModal', () => ({
  MatchOutgoingBankTransactionModal: () => null,
}));
vi.mock('@/components/ui/UnreconcileBankTransactionModal', () => ({
  UnreconcileBankTransactionModal: () => null,
}));
vi.mock('@/components/ui/BankTransactionCreateModal', () => ({
  BankTransactionCreateModal: () => null,
}));
// Календар — не мета тесту: поле дати як звичайний input зі значенням YYYY-MM-DD.
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

const useBankTransactionsMock = vi.fn();
vi.mock('@/hooks/api/useBankStatements', () => ({
  useBankTransactions: (...a: unknown[]) => useBankTransactionsMock(...a),
  useIgnoreBankTransaction: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteBankTransaction: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import BankTransactionsTab from '../BankTransactionsTab';

const SEARCH = 'Пошук за контрагентом, призначенням, IBAN…';
const lastFilter = () => useBankTransactionsMock.mock.lastCall![0] as Record<string, unknown>;
const typeSearch = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText(SEARCH), { target: { value } });
const debounce = () => act(() => void vi.advanceTimersByTime(300));
const dates = () => screen.getAllByTestId('date') as HTMLInputElement[];

describe('BankTransactionsTab — пошук і дати', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useBankTransactionsMock.mockReset();
    // 3 сторінки по 20 — щоб було з чого скидати пагінацію.
    useBankTransactionsMock.mockReturnValue({ data: { items: [], total: 60 }, isLoading: false });
  });
  afterEach(() => vi.useRealTimers());

  it('за замовчуванням дати порожні й у запит не йдуть — як і пошук', () => {
    render(<BankTransactionsTab />);
    expect(dates().map(d => d.value)).toEqual(['', '']);
    const f = lastFilter();
    expect(f.q).toBeUndefined();
    expect(f.dateFrom).toBeUndefined();
    expect(f.dateTo).toBeUndefined();
  });

  it('пошук іде у фільтр хука лише після debounce, обрізаний від пробілів', () => {
    render(<BankTransactionsTab />);
    typeSearch('  Петренко ');
    expect(lastFilter().q).toBeUndefined();
    debounce();
    expect(lastFilter().q).toBe('Петренко');
  });

  it('пошук із самих пробілів не надсилається', () => {
    render(<BankTransactionsTab />);
    typeSearch('   ');
    debounce();
    expect(lastFilter().q).toBeUndefined();
  });

  it('дати «З» і «По» йдуть у фільтр і взаємно обмежують одна одну', () => {
    render(<BankTransactionsTab />);
    fireEvent.change(dates()[0]!, { target: { value: '2026-09-01' } });
    fireEvent.change(dates()[1]!, { target: { value: '2026-09-30' } });
    expect(lastFilter()).toEqual(
      expect.objectContaining({ dateFrom: '2026-09-01', dateTo: '2026-09-30' }),
    );
    expect(dates()[0]!.dataset.max).toBe('2026-09-30');
    expect(dates()[1]!.dataset.min).toBe('2026-09-01');
  });

  it('пошук і дати працюють разом зі status і direction', () => {
    render(<BankTransactionsTab direction="IN" />);
    fireEvent.click(screen.getByRole('button', { name: 'Не рознесено' }));
    typeSearch('оплата');
    debounce();
    fireEvent.change(dates()[0]!, { target: { value: '2026-09-01' } });
    expect(lastFilter()).toEqual(
      expect.objectContaining({
        status: 'UNMATCHED',
        direction: 'IN',
        q: 'оплата',
        dateFrom: '2026-09-01',
      }),
    );
  });

  it.each([
    ['пошуку', () => typeSearch('а')],
    ['дати «З»', () => fireEvent.change(dates()[0]!, { target: { value: '2026-09-01' } })],
    ['дати «По»', () => fireEvent.change(dates()[1]!, { target: { value: '2026-09-30' } })],
  ])('зміна %s повертає на першу сторінку', (_name, change) => {
    render(<BankTransactionsTab />);
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(lastFilter().page).toBe(2);
    change();
    expect(lastFilter().page).toBe(1);
  });

  it('рядок пошуку стоїть між фільтрами статусу й таблицею; «Імпорт виписки» — у ньому праворуч', () => {
    render(<BankTransactionsTab />);
    const statusRow = screen.getByRole('button', { name: 'Усі' }).parentElement!;
    const searchRow = screen.getByPlaceholderText(SEARCH).closest('div.flex-wrap')!;
    const table = screen.getByRole('table');
    const importBtn = screen.getByRole('button', { name: /Імпорт виписки/ });

    expect(searchRow).not.toBe(statusRow);
    expect(statusRow.contains(importBtn)).toBe(false);
    expect(searchRow.contains(importBtn)).toBe(true);
    // Дії сторінки — останній блок рядка, притиснутий праворуч.
    expect(searchRow.lastElementChild!.contains(importBtn)).toBe(true);
    expect(searchRow.lastElementChild).toHaveClass('ml-auto');
    // Порядок у документі: статуси → рядок пошуку → таблиця.
    expect(
      statusRow.compareDocumentPosition(searchRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      searchRow.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // У рядку — пошук, далі «З», далі «По».
    const [from, to] = dates();
    const search = screen.getByPlaceholderText(SEARCH);
    expect(search.compareDocumentPosition(from!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(from!.compareDocumentPosition(to!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(searchRow).toHaveTextContent('З');
    expect(searchRow).toHaveTextContent('По');
  });

  // Bug #816: довший за 100 символів `q` бекенд або відхиляє (400), або мовчки обрізає — поле
  // не дає ввести більше, ніж буде знайдено.
  it('поле пошуку обмежене 100 символами — межа бекенду', () => {
    render(<BankTransactionsTab />);
    expect(screen.getByPlaceholderText(SEARCH)).toHaveAttribute('maxlength', '100');
  });
});
