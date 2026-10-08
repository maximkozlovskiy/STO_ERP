// Regression-guard для рядка вкладок сторінки /bank-statements.
//
// Рішення власника 2026-10-08: вкладки — як на «Купівлі» і «Складі». Зліва розрізи списку
// платежів за напрямком («Всі» / «Вхідні» / «Вихідні»), праворуч — «Банк. рахунки». Окремої
// вкладки «Список платежів» більше немає.
//
// Load-bearing поведінка:
//   - default (без параметрів) → список платежів без фільтра напрямку;
//   - ?direction=IN|OUT → той самий список із напрямком; невідоме значення → без фільтра;
//   - ?tab=accounts → BankAccountsTab; «Банк. рахунки» — остання вкладка рядка;
//   - клік по вкладці → router.replace на відповідний URL.

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => undefined,
}));

const replaceMock = vi.fn();
let search: Record<string, string> = {};
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => ({ get: (k: string) => search[k] ?? null }),
}));

// Дочірні вкладки — стуби (dynamic(() => import('./X')) резолвить ці модулі).
vi.mock('../BankTransactionsTab', () => ({
  default: ({ direction }: { direction?: string }) => (
    <div data-testid="transactions-tab" data-direction={direction ?? ''}>
      TRANSACTIONS
    </div>
  ),
}));
vi.mock('../BankAccountsTab', () => ({
  default: () => <div data-testid="accounts-tab">ACCOUNTS</div>,
}));

import BankStatementsPage from '../page';

const transactionsTab = () => screen.findByTestId('transactions-tab');

describe('BankStatementsPage — рядок вкладок', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    search = {};
  });

  it('вкладки: «Всі», «Вхідні», «Вихідні» і остання праворуч — «Банк. рахунки»; «Список платежів» немає', async () => {
    render(<BankStatementsPage />);
    const all = await screen.findByRole('button', { name: 'Всі' });
    const accounts = screen.getByRole('button', { name: 'Банк. рахунки' });
    expect(screen.getByRole('button', { name: 'Вхідні' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Вихідні' })).toBeInTheDocument();
    expect(accounts.parentElement).toBe(all.parentElement);
    expect(accounts.parentElement?.lastElementChild).toBe(accounts);
    expect(screen.queryByRole('button', { name: 'Список платежів' })).not.toBeInTheDocument();
  });

  it('без параметрів → список платежів без фільтра напрямку, активна «Всі»', async () => {
    render(<BankStatementsPage />);
    expect(await transactionsTab()).toHaveAttribute('data-direction', '');
    expect(screen.queryByTestId('accounts-tab')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Всі' })).toHaveAttribute('aria-current', 'page');
  });

  it.each([
    ['IN', 'Вхідні'],
    ['OUT', 'Вихідні'],
  ])('?direction=%s → список із цим напрямком, активна «%s»', async (direction, label) => {
    search = { direction };
    render(<BankStatementsPage />);
    expect(await transactionsTab()).toHaveAttribute('data-direction', direction);
    expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Всі' })).not.toHaveAttribute('aria-current');
  });

  it('невідомий ?direction= відкидається — список без фільтра', async () => {
    search = { direction: 'SIDEWAYS' };
    render(<BankStatementsPage />);
    expect(await transactionsTab()).toHaveAttribute('data-direction', '');
  });

  it('?tab=accounts → вкладка «Банк. рахунки», жодна вкладка напрямку не активна', async () => {
    search = { tab: 'accounts' };
    render(<BankStatementsPage />);
    await waitFor(() => expect(screen.getByTestId('accounts-tab')).toBeInTheDocument());
    expect(screen.queryByTestId('transactions-tab')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Банк. рахунки' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('button', { name: 'Всі' })).not.toHaveAttribute('aria-current');
  });

  it.each([
    ['Вхідні', '/bank-statements?direction=IN'],
    ['Вихідні', '/bank-statements?direction=OUT'],
    ['Банк. рахунки', '/bank-statements?tab=accounts'],
  ])('клік по «%s» → router.replace(%s)', async (label, url) => {
    render(<BankStatementsPage />);
    fireEvent.click(await screen.findByRole('button', { name: label }));
    expect(replaceMock).toHaveBeenCalledWith(url, { scroll: false });
  });

  it('клік по «Всі» з вкладки рахунків → /bank-statements без параметрів', async () => {
    search = { tab: 'accounts' };
    render(<BankStatementsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Всі' }));
    expect(replaceMock).toHaveBeenCalledWith('/bank-statements', { scroll: false });
  });
});
