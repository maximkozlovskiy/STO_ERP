// «Банківські платежі»: «Сторнувати оплату» на вхідному рядку, рознесеному на оплату клієнта
// (BR-PAY-024, BR-BANK-040, рішення власника 2026-10-22).
//
// Що стереже:
//   - кнопка є лише на вхідному MATCHED-рядку з `paymentId`; «Зняти рознесення» там немає;
//   - вихідний, нерознесений і рознесений без оплати (переказ) — без кнопки;
//   - кнопка відкриває картку сторно ОПЛАТИ (id оплати, не рядка), із сумою й валютою рядка,
//     платником і позначкою «з виписки» — картка обіцяє «Нерознесений» без «якщо».
//
// Mutation-verify:
//   - прибрати `tx.direction === 'IN' &&` з canReversePayment → «вихідний без кнопки» падає;
//   - `id: tx.paymentId` → `id: tx.id` → «id оплати» падає;
//   - прибрати `fromBankStatement: true` → «з виписки» падає.

import { render, screen, fireEvent, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

vi.mock('@/lib/format', () => ({
  fmtMoney: (v: number) => String(v),
  fmtDate: (v: string) => `d:${v}`,
  fmtBankCurrencySuffix: (c: string | null | undefined) => (!c || c === 'UAH' ? '₴' : c),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

interface ReversalStubProps {
  open: boolean;
  payment: {
    id: string;
    amountText: string;
    dateText: string;
    partyName?: string | null;
    fromBankStatement?: boolean;
  } | null;
}
vi.mock('@/components/ui/PaymentReversalModal', () => ({
  PaymentReversalModal: (p: ReversalStubProps) =>
    p.open && p.payment ? (
      <div
        data-testid="payment-reversal"
        data-id={p.payment.id}
        data-amount={p.payment.amountText}
        data-date={p.payment.dateText}
        data-party={p.payment.partyName ?? ''}
        data-from-bank={String(!!p.payment.fromBankStatement)}
      />
    ) : null,
}));
vi.mock('@/components/ui/MatchBankTransactionModal', () => ({
  MatchBankTransactionModal: () => null,
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
vi.mock('@/components/ui/BankStatementImportModal', () => ({
  BankStatementImportModal: () => null,
}));

const useBankTransactionsMock = vi.fn();
vi.mock('@/hooks/api/useBankStatements', () => ({
  useBankTransactions: (...a: unknown[]) => useBankTransactionsMock(...a),
  useIgnoreBankTransaction: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteBankTransaction: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import BankTransactionsTab from '../BankTransactionsTab';

const PAY = 'pay-1';

const tx = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  orgId: 'o1',
  bankAccountId: 'ba1',
  direction: 'IN',
  amount: 1500,
  currencyId: 'c1',
  operationDate: '2026-10-20',
  payerName: 'Коваль Олег з виписки',
  counterpartyName: 'Коваль Олег',
  purpose: 'Оплата за ремонт',
  externalId: 'ext1',
  source: 'FILE_IMPORT',
  status: 'MATCHED',
  matchedType: 'SERVICE',
  paymentId: PAY,
  createdAt: '2026-10-20T00:00:00.000Z',
  bankAccountName: 'Основний',
  bankAccountCurrencyCode: 'UAH',
  ...over,
});

const show = (...items: ReturnType<typeof tx>[]) =>
  useBankTransactionsMock.mockReturnValue({
    data: { items, total: items.length },
    isLoading: false,
  });

const dataRow = (index = 0) => screen.getAllByRole('row')[index + 1]!;
const REVERSE = 'Сторнувати оплату';

describe('BankTransactionsTab — «Сторнувати оплату» (BR-PAY-024, BR-BANK-040)', () => {
  beforeEach(() => {
    useBankTransactionsMock.mockReset();
  });

  // guards: BR-PAY-024, BR-BANK-040
  it('вхідний рознесений на оплату: «Сторнувати оплату», без «Зняти рознесення»', () => {
    show(tx());
    render(<BankTransactionsTab />);
    const row = dataRow(0);
    expect(within(row).getByRole('button', { name: REVERSE })).toBeVisible();
    expect(within(row).queryByRole('button', { name: 'Зняти рознесення' })).toBeNull();
  });

  // guards: BR-PAY-024
  it.each([
    ['вихідний рознесений', { direction: 'OUT', matchedType: 'EXPENSE', paymentId: null }],
    // Захист за напрямом: вихідний рядок оплату клієнта не створює, навіть якщо посилання є.
    ['вихідний із посиланням на оплату', { direction: 'OUT', matchedType: 'CLIENT_REFUND' }],
    ['вхідний нерознесений', { status: 'UNMATCHED', matchedType: null, paymentId: null }],
    ['вхідний переказ без оплати', { matchedType: 'TRANSFER', paymentId: null }],
    ['вхідний ігнорований', { status: 'IGNORED', matchedType: null, paymentId: null }],
  ])('%s — кнопки немає', (_n, over) => {
    show(tx(over));
    render(<BankTransactionsTab />);
    expect(within(dataRow(0)).queryByRole('button', { name: REVERSE })).toBeNull();
  });

  // guards: BR-PAY-024, BR-BANK-040
  it('кнопка відкриває картку сторно оплати: id оплати, сума з валютою, платник, «з виписки»', () => {
    show(tx({ bankAccountCurrencyCode: 'USD', amount: 200 }));
    render(<BankTransactionsTab />);
    expect(screen.queryByTestId('payment-reversal')).toBeNull();
    fireEvent.click(within(dataRow(0)).getByRole('button', { name: REVERSE }));
    const card = screen.getByTestId('payment-reversal');
    expect(card).toHaveAttribute('data-id', PAY);
    expect(card).toHaveAttribute('data-amount', '200 USD');
    expect(card).toHaveAttribute('data-date', 'd:2026-10-20');
    expect(card).toHaveAttribute('data-party', 'Коваль Олег');
    expect(card).toHaveAttribute('data-from-bank', 'true');
  });
});
