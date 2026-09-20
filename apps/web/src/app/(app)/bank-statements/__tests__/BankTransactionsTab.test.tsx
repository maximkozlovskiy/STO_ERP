// Regression-guard для BankTransactionsTab — колонка «Рахунок» (UI-реорганізація навколо
// банківських рахунків). Показує назву рахунку-отримувача, або скорочений IBAN, або «—».

import { render, screen } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

vi.mock('@/lib/format', () => ({
  fmtMoney: (v: number) => String(v),
  fmtDate: (v: string) => v,
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
