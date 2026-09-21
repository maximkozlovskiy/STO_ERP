// Regression-guard для BankTransactionsTab — колонка «Рахунок» (UI-реорганізація навколо
// банківських рахунків). Показує назву рахунку-отримувача, або скорочений IBAN, або «—».

import { render, screen } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

vi.mock('@/lib/format', () => ({
  fmtMoney: (v: number) => String(v),
  fmtDate: (v: string) => v,
  fmtBankCurrencySuffix: (c: string | null | undefined) => (!c || c === 'UAH' ? '₴' : c),
}));

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Модалки — стуби (не мета тесту).
vi.mock('@/components/ui/MatchBankTransactionModal', () => ({
  MatchBankTransactionModal: () => null,
}));
vi.mock('@/components/ui/BankStatementImportModal', () => ({
  BankStatementImportModal: () => null,
}));

const useBankTransactionsMock = vi.fn();
vi.mock('@/hooks/api/useBankStatements', () => ({
  useBankTransactions: (...a: unknown[]) => useBankTransactionsMock(...a),
  useIgnoreBankTransaction: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import BankTransactionsTab from '../BankTransactionsTab';

const tx = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  orgId: 'o1',
  bankAccountId: 'ba1',
  direction: 'IN',
  amount: 1000,
  currencyId: 'c1',
  operationDate: '2026-09-01',
  payerName: 'Петренко',
  purpose: 'Оплата',
  externalId: 'ext1',
  source: 'IMPORT',
  status: 'MATCHED',
  createdAt: '2026-09-01T00:00:00.000Z',
  bankAccountName: null,
  bankAccountIban: null,
  ...over,
});

describe('BankTransactionsTab — колонка «Рахунок»', () => {
  beforeEach(() => {
    useBankTransactionsMock.mockReset();
  });

  it('заголовок колонки «Рахунок» присутній', () => {
    useBankTransactionsMock.mockReturnValue({ data: { items: [], total: 0 }, isLoading: false });
    render(<BankTransactionsTab />);
    expect(screen.getByRole('columnheader', { name: 'Рахунок' })).toBeInTheDocument();
  });

  it('bankAccountName → показує назву рахунку', () => {
    useBankTransactionsMock.mockReturnValue({
      data: { items: [tx({ bankAccountName: 'Основний рахунок' })], total: 1 },
      isLoading: false,
    });
    render(<BankTransactionsTab />);
    expect(screen.getByText('Основний рахунок')).toBeInTheDocument();
  });

  it('без назви, але з IBAN → скорочений IBAN (…останні 4)', () => {
    useBankTransactionsMock.mockReturnValue({
      data: {
        items: [tx({ bankAccountName: null, bankAccountIban: 'UA213223130000026007233566001' })],
        total: 1,
      },
      isLoading: false,
    });
    render(<BankTransactionsTab />);
    expect(screen.getByText('…6001')).toBeInTheDocument();
  });

  it('без назви й без IBAN → «—»', () => {
    useBankTransactionsMock.mockReturnValue({
      data: { items: [tx({ bankAccountName: null, bankAccountIban: null })], total: 1 },
      isLoading: false,
    });
    render(<BankTransactionsTab />);
    // payer «Петренко» присутній, а account-клітинка — «—».
    expect(screen.getByText('Петренко')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });
});

// Регресія-guard валютного фіксу (e4fc5e7c): сума показується у валюті рахунку-отримувача
// (multi-bank: USD/EUR-рахунок), а не хардкод «₴». UAH/невідомий код → «₴», інші → код.
// fmtMoney замокано на String(v), тож сума + суфікс рендеряться як один текстовий вузол.
describe('BankTransactionsTab — валюта суми (multi-bank)', () => {
  beforeEach(() => useBankTransactionsMock.mockReset());

  const oneTx = (over: Record<string, unknown>) =>
    useBankTransactionsMock.mockReturnValue({
      data: { items: [tx(over)], total: 1 },
      isLoading: false,
    });

  it('UAH-рахунок → суфікс «₴»', () => {
    oneTx({ amount: 1000, bankAccountCurrencyCode: 'UAH' });
    render(<BankTransactionsTab />);
    expect(screen.getByText('1000 ₴')).toBeInTheDocument();
  });

  it('код валюти відсутній (null) → фолбек «₴»', () => {
    oneTx({ amount: 1000, bankAccountCurrencyCode: null });
    render(<BankTransactionsTab />);
    expect(screen.getByText('1000 ₴')).toBeInTheDocument();
  });

  it('USD-рахунок → суфікс «USD» (не хардкод ₴)', () => {
    oneTx({ amount: 150, bankAccountCurrencyCode: 'USD' });
    render(<BankTransactionsTab />);
    expect(screen.getByText('150 USD')).toBeInTheDocument();
    expect(screen.queryByText('150 ₴')).not.toBeInTheDocument();
  });

  it('EUR-рахунок → суфікс «EUR»', () => {
    oneTx({ amount: 200, bankAccountCurrencyCode: 'EUR' });
    render(<BankTransactionsTab />);
    expect(screen.getByText('200 EUR')).toBeInTheDocument();
  });
});
