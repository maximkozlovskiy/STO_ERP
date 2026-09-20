// Regression-guard для вкладкового shell сторінки /bank-statements (UI-реорганізація
// навколо банківських рахунків). Дзеркалить tab-shell /cash: Suspense → inner shell,
// dynamic-import вкладок, URL ?tab= через useSearchParams + router.replace.
//
// Load-bearing поведінка:
//   - Дві вкладки: «Список платежів» (transactions) + «Банк. рахунки» (accounts).
//   - default (без ?tab=) → transactions.
//   - ?tab=accounts → рендер BankAccountsTab.
//   - клік по вкладці → router.replace на відповідний URL.

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => undefined,
}));

const replaceMock = vi.fn();
let searchTab: string | null = null;
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => ({ get: (k: string) => (k === 'tab' ? searchTab : null) }),
}));

// Дочірні вкладки — стуби (dynamic(() => import('./X')) резолвить ці модулі).
vi.mock('../BankTransactionsTab', () => ({
  default: () => <div data-testid="transactions-tab">TRANSACTIONS</div>,
}));
vi.mock('../BankAccountsTab', () => ({
  default: () => <div data-testid="accounts-tab">ACCOUNTS</div>,
}));

import BankStatementsPage from '../page';

describe('BankStatementsPage — вкладковий shell', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    searchTab = null;
  });

  it('дефолт (без ?tab=) → вкладка «Список платежів»', async () => {
    render(<BankStatementsPage />);
    await waitFor(() => expect(screen.getByTestId('transactions-tab')).toBeInTheDocument());
    expect(screen.queryByTestId('accounts-tab')).not.toBeInTheDocument();
  });

  it('обидві вкладки присутні у заголовку', async () => {
    render(<BankStatementsPage />);
    expect(await screen.findByRole('button', { name: 'Список платежів' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Банк. рахунки' })).toBeInTheDocument();
  });

  it('?tab=accounts → рендер вкладки «Банк. рахунки»', async () => {
    searchTab = 'accounts';
    render(<BankStatementsPage />);
    await waitFor(() => expect(screen.getByTestId('accounts-tab')).toBeInTheDocument());
    expect(screen.queryByTestId('transactions-tab')).not.toBeInTheDocument();
  });

  it('клік по вкладці «Банк. рахунки» → router.replace(?tab=accounts)', async () => {
    render(<BankStatementsPage />);
    const btn = await screen.findByRole('button', { name: 'Банк. рахунки' });
    fireEvent.click(btn);
    expect(replaceMock).toHaveBeenCalledWith('/bank-statements?tab=accounts', { scroll: false });
  });

  it('клік по вкладці «Список платежів» → router.replace(/bank-statements) без query', async () => {
    searchTab = 'accounts';
    render(<BankStatementsPage />);
    const btn = await screen.findByRole('button', { name: 'Список платежів' });
    fireEvent.click(btn);
    expect(replaceMock).toHaveBeenCalledWith('/bank-statements', { scroll: false });
  });
});
