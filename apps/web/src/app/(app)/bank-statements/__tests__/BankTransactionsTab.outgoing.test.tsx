// Вихідні банківські платежі у списку (BR-BANK-017…040, рішення власника 2026-10-09):
//   - колонка «Контрагент» (для вихідного payerName — це отримувач, BR-BANK-020);
//   - сума зі знаком і кольором за напрямом;
//   - колонка «Рознесено як»: вид + з чим пов'язано; у нерознесеного — причина скасування;
//   - дії рядка залежать від напряму, статусу й джерела;
//   - «Новий платіж» відкриває форму з напрямом вкладки.
//
// Mutation-verify (кожен кейс перевірено тимчасовою правкою компонента):
//   - знак `'−'` для OUT → `'+'`                         → «вихідний — мінус» падає;
//   - `tx.direction === 'OUT' ? setReconcile : setMatchTx` навпаки → «OUT відкриває нову модалку» падає;
//   - прибрати `!tx.paymentId` з canUnreconcile          → «MATCHED з paymentId — кнопки немає» падає;
//   - прибрати `tx.source === 'MANUAL' &&`               → «рядок із виписки не видаляється» падає;
//   - `defaultDirection={direction ?? 'IN'}` → `'IN'`    → «напрям вкладки» падає.

import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

vi.mock('@/lib/format', () => ({
  fmtMoney: (v: number) => String(v),
  fmtDate: (v: string) => `d:${v}`,
  fmtBankCurrencySuffix: (c: string | null | undefined) => (!c || c === 'UAH' ? '₴' : c),
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

// Модалки — стуби-маркери: показують, ЯКУ модалку і з якими пропами відкрив список.
interface StubProps {
  open: boolean;
  transaction?: { id: string } | null;
  allowedTypes?: readonly string[];
  defaultDirection?: string;
}
vi.mock('@/components/ui/MatchBankTransactionModal', () => ({
  MatchBankTransactionModal: (p: StubProps) =>
    p.open ? <div data-testid="match-in">{p.transaction?.id}</div> : null,
}));
vi.mock('@/components/ui/MatchOutgoingBankTransactionModal', () => ({
  MatchOutgoingBankTransactionModal: (p: StubProps) =>
    p.open ? (
      <div data-testid="match-out" data-allowed={(p.allowedTypes ?? []).join(',')}>
        {p.transaction?.id}
      </div>
    ) : null,
}));
vi.mock('@/components/ui/UnreconcileBankTransactionModal', () => ({
  UnreconcileBankTransactionModal: (p: StubProps) =>
    p.open ? <div data-testid="unreconcile">{p.transaction?.id}</div> : null,
}));
vi.mock('@/components/ui/BankTransactionCreateModal', () => ({
  BankTransactionCreateModal: (p: StubProps) =>
    p.open ? <div data-testid="create" data-direction={p.defaultDirection} /> : null,
}));
vi.mock('@/components/ui/BankStatementImportModal', () => ({
  BankStatementImportModal: () => null,
}));

const useBankTransactionsMock = vi.fn();
const deleteMutateMock = vi.fn();
vi.mock('@/hooks/api/useBankStatements', () => ({
  useBankTransactions: (...a: unknown[]) => useBankTransactionsMock(...a),
  useIgnoreBankTransaction: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteBankTransaction: () => ({ mutateAsync: deleteMutateMock, isPending: false }),
}));

import BankTransactionsTab from '../BankTransactionsTab';

const tx = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  orgId: 'o1',
  bankAccountId: 'ba1',
  direction: 'OUT',
  amount: 1200,
  currencyId: 'c1',
  operationDate: '2026-10-01',
  payerName: 'ТОВ Постачальник',
  purpose: 'Оплата за запчастини',
  externalId: 'ext1',
  source: 'FILE_IMPORT',
  status: 'UNMATCHED',
  createdAt: '2026-10-01T00:00:00.000Z',
  bankAccountName: 'Основний',
  bankAccountCurrencyCode: 'UAH',
  ...over,
});

const show = (...items: ReturnType<typeof tx>[]) =>
  useBankTransactionsMock.mockReturnValue({
    data: { items, total: items.length },
    isLoading: false,
  });

/** Рядок таблиці з даними (перший рядок — заголовок). */
const dataRow = (index = 0) => screen.getAllByRole('row')[index + 1]!;

describe('BankTransactionsTab — колонки вихідних платежів', () => {
  beforeEach(() => {
    useBankTransactionsMock.mockReset();
    deleteMutateMock.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  it.each([undefined, 'IN', 'OUT'] as const)(
    'заголовок «Контрагент», а не «Платник» (вкладка %s)',
    direction => {
      show(tx());
      render(<BankTransactionsTab direction={direction} />);
      expect(screen.getByRole('columnheader', { name: 'Контрагент' })).toBeInTheDocument();
      expect(screen.queryByRole('columnheader', { name: 'Платник' })).not.toBeInTheDocument();
      // У клітинці — payerName: для вихідного це отримувач.
      expect(screen.getByText('ТОВ Постачальник')).toBeInTheDocument();
    },
  );

  it('вихідний — мінус і колір списання; вирівняно праворуч, tabular-nums', () => {
    show(tx({ direction: 'OUT', amount: 1200 }));
    render(<BankTransactionsTab />);
    const cell = screen.getByText('−1200 ₴');
    expect(cell).toHaveClass('text-destructive', 'text-right', 'tabular-nums');
    expect(cell).not.toHaveClass('text-success');
  });

  it('вхідний — плюс і колір надходження', () => {
    show(tx({ direction: 'IN', amount: 500, bankAccountCurrencyCode: 'USD' }));
    render(<BankTransactionsTab />);
    const cell = screen.getByText('+500 USD');
    expect(cell).toHaveClass('text-success', 'text-right', 'tabular-nums');
    expect(cell).not.toHaveClass('text-destructive');
  });

  it('ручний рядок позначено «Внесено вручну»; рядок із виписки — ні', () => {
    show(tx({ id: 'm', source: 'MANUAL' }), tx({ id: 'f', source: 'FILE_IMPORT' }));
    render(<BankTransactionsTab />);
    expect(within(dataRow(0)).getByText('Внесено вручну')).toBeInTheDocument();
    expect(within(dataRow(1)).queryByText('Внесено вручну')).not.toBeInTheDocument();
  });
});

describe('BankTransactionsTab — колонка «Рознесено як»', () => {
  beforeEach(() => useBankTransactionsMock.mockReset());

  const matched = (over: Record<string, unknown>) => tx({ status: 'MATCHED', ...over });

  it('заголовок колонки присутній', () => {
    show(tx());
    render(<BankTransactionsTab />);
    expect(screen.getByRole('columnheader', { name: 'Рознесено як' })).toBeInTheDocument();
  });

  it.each([
    [
      'SUPPLIER_PAYMENT',
      { counterpartyName: 'ТОВ Запчастини', supplierPaymentNumber: 'SP-0007' },
      'Оплата постачальнику',
      'ТОВ Запчастини · Оплата № SP-0007',
    ],
    ['CLIENT_REFUND', { counterpartyName: 'Іваненко Іван' }, 'Повернення клієнту', 'Іваненко Іван'],
    ['EXPENSE', { expenseCategoryName: 'Оренда' }, 'Витрата', 'Оренда'],
    [
      'EXPENSE',
      { expenseCategoryName: 'Оренда', counterpartyName: 'ФОП Орендодавець' },
      'Витрата',
      'ФОП Орендодавець · Оренда',
    ],
    [
      'PAYROLL',
      {
        payrollPeriodStart: '2026-09-01',
        payrollPeriodEnd: '2026-09-30',
        employeeName: 'Петренко Петро',
      },
      'Зарплата',
      'd:2026-09-01 – d:2026-09-30 · Петренко Петро',
    ],
    [
      'PAYROLL',
      { payrollPeriodStart: '2026-09-01', payrollPeriodEnd: '2026-09-30' },
      'Зарплата',
      'd:2026-09-01 – d:2026-09-30',
    ],
    [
      'TRANSFER',
      { transferBankAccountName: 'Валютний рахунок' },
      'Переказ між рахунками',
      'Валютний рахунок',
    ],
  ] as const)('%s %j → «%s» + «%s»', (matchedType, fields, label, detail) => {
    show(matched({ matchedType, ...fields }));
    render(<BankTransactionsTab />);
    const row = dataRow();
    expect(within(row).getByText(label)).toBeInTheDocument();
    expect(within(row).getByText(detail)).toBeInTheDocument();
  });

  it('CASH_WITHDRAWAL — лише підпис виду (деталі немає)', () => {
    show(matched({ matchedType: 'CASH_WITHDRAWAL', cashOperationId: 'co1' }));
    render(<BankTransactionsTab />);
    expect(within(dataRow()).getByText('Зняття готівки')).toBeInTheDocument();
  });

  it('вхідний, рознесений через match, показує свій вид і контрагента', () => {
    show(
      matched({
        direction: 'IN',
        matchedType: 'PREPAYMENT',
        paymentId: 'p1',
        counterpartyName: 'ТОВ Клієнт',
      }),
    );
    render(<BankTransactionsTab />);
    expect(within(dataRow()).getByText('Аванс')).toBeInTheDocument();
    expect(within(dataRow()).getByText('ТОВ Клієнт')).toBeInTheDocument();
  });

  it('UNMATCHED — порожньо: виду й контрагента рознесення в рядку немає', () => {
    show(tx({ status: 'UNMATCHED', matchedType: null }));
    render(<BankTransactionsTab />);
    const cells = within(dataRow()).getAllByRole('cell');
    // дата · контрагент · рахунок · призначення · сума · статус · РОЗНЕСЕНО ЯК · дії
    expect(cells).toHaveLength(8);
    expect(cells[6]).toBeEmptyDOMElement();
  });

  it('нерознесений рядок зі скасованим рознесенням показує причину, а дату — у підказці', () => {
    show(
      tx({
        status: 'UNMATCHED',
        unmatchReason: 'помилковий постачальник',
        unmatchedAt: '2026-10-03T09:00:00.000Z',
      }),
    );
    render(<BankTransactionsTab />);
    const note = screen.getByText('Рознесення скасовано: помилковий постачальник');
    expect(note).toHaveAttribute('title', 'Скасовано d:2026-10-03T09:00:00.000Z');
  });
});

describe('BankTransactionsTab — дії рядка за напрямом і статусом', () => {
  beforeEach(() => {
    useBankTransactionsMock.mockReset();
    deleteMutateMock.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  it('UNMATCHED + OUT: «Рознести» відкриває модалку вихідного платежу з усіма видами', () => {
    show(tx({ id: 'out-1', direction: 'OUT' }));
    render(<BankTransactionsTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Рознести' }));
    const modal = screen.getByTestId('match-out');
    expect(modal).toHaveTextContent('out-1');
    expect(modal).toHaveAttribute('data-allowed', '');
    expect(screen.queryByTestId('match-in')).not.toBeInTheDocument();
  });

  it('UNMATCHED + OUT: пункту «Переказ між рахунками» окремо немає — він серед видів', () => {
    show(tx({ direction: 'OUT' }));
    render(<BankTransactionsTab />);
    expect(screen.queryByRole('button', { name: 'Переказ між рахунками' })).not.toBeInTheDocument();
  });

  it('UNMATCHED + IN: «Рознести» відкриває наявну модалку вхідного платежу', () => {
    show(tx({ id: 'in-1', direction: 'IN' }));
    render(<BankTransactionsTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Рознести' }));
    expect(screen.getByTestId('match-in')).toHaveTextContent('in-1');
    expect(screen.queryByTestId('match-out')).not.toBeInTheDocument();
  });

  it('UNMATCHED + IN: «Переказ між рахунками» відкриває нову модалку лише з видом TRANSFER', () => {
    show(tx({ id: 'in-1', direction: 'IN' }));
    render(<BankTransactionsTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Переказ між рахунками' }));
    const modal = screen.getByTestId('match-out');
    expect(modal).toHaveTextContent('in-1');
    expect(modal).toHaveAttribute('data-allowed', 'TRANSFER');
    expect(screen.queryByTestId('match-in')).not.toBeInTheDocument();
  });

  it.each(['IN', 'OUT'] as const)('UNMATCHED + %s: «Ігнорувати» лишається', direction => {
    show(tx({ direction }));
    render(<BankTransactionsTab />);
    expect(screen.getByRole('button', { name: 'Ігнорувати' })).toBeInTheDocument();
  });

  it.each(['SUPPLIER_PAYMENT', 'CLIENT_REFUND', 'EXPENSE', 'PAYROLL', 'CASH_WITHDRAWAL'] as const)(
    'MATCHED через reconcile (%s, без paymentId): «Зняти рознесення» відкриває свою модалку',
    matchedType => {
      show(tx({ id: 'm-1', status: 'MATCHED', matchedType }));
      render(<BankTransactionsTab />);
      fireEvent.click(screen.getByRole('button', { name: 'Зняти рознесення' }));
      expect(screen.getByTestId('unreconcile')).toHaveTextContent('m-1');
      // Рознесений рядок не розносять і не ігнорують повторно.
      expect(screen.queryByRole('button', { name: 'Рознести' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Ігнорувати' })).not.toBeInTheDocument();
    },
  );

  it('MATCHED вхідний із TRANSFER (reconcile) теж можна зняти', () => {
    show(tx({ direction: 'IN', status: 'MATCHED', matchedType: 'TRANSFER' }));
    render(<BankTransactionsTab />);
    expect(screen.getByRole('button', { name: 'Зняти рознесення' })).toBeInTheDocument();
  });

  // BR-BANK-040: сторно оплати клієнта в системі немає.
  it('MATCHED з paymentId (вхідний через match): «Зняти рознесення» немає', () => {
    show(tx({ direction: 'IN', status: 'MATCHED', matchedType: 'PREPAYMENT', paymentId: 'p1' }));
    render(<BankTransactionsTab />);
    expect(screen.queryByRole('button', { name: 'Зняти рознесення' })).not.toBeInTheDocument();
  });

  it('MATCHED із «вихідним» видом, але з paymentId — кнопки теж немає', () => {
    show(tx({ status: 'MATCHED', matchedType: 'EXPENSE', paymentId: 'p1' }));
    render(<BankTransactionsTab />);
    expect(screen.queryByRole('button', { name: 'Зняти рознесення' })).not.toBeInTheDocument();
  });

  it('MATCHED вхідний без paymentId, але з видом match (сирота) — кнопки немає: бек відмовить', () => {
    show(tx({ direction: 'IN', status: 'MATCHED', matchedType: 'SERVICE', paymentId: null }));
    render(<BankTransactionsTab />);
    expect(screen.queryByRole('button', { name: 'Зняти рознесення' })).not.toBeInTheDocument();
  });

  it('IGNORED: дій немає', () => {
    show(tx({ status: 'IGNORED', source: 'MANUAL' }));
    render(<BankTransactionsTab />);
    expect(within(dataRow()).queryAllByRole('button')).toHaveLength(0);
  });

  // ── Видалення ручного рядка (BR-BANK-024) ──────────────────────────────────
  it('ручний UNMATCHED: видалення питає підтвердження і лише потім шле запит', async () => {
    deleteMutateMock.mockResolvedValue(undefined);
    show(tx({ id: 'man-1', source: 'MANUAL', operationDate: '2026-10-02' }));
    render(<BankTransactionsTab />);

    fireEvent.click(screen.getByRole('button', { name: 'Видалити платіж' }));
    expect(deleteMutateMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Видалити платіж?' });
    expect(within(dialog).getByText(/d:2026-10-02/)).toBeInTheDocument();
    expect(within(dialog).getByText(/−1200 ₴/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Видалити' }));
    await waitFor(() => expect(deleteMutateMock).toHaveBeenCalledWith('man-1'));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Платіж видалено'));
  });

  it('скасування підтвердження нічого не видаляє', () => {
    show(tx({ source: 'MANUAL' }));
    render(<BankTransactionsTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Видалити платіж' }));
    const dialog = screen.getByRole('dialog', { name: 'Видалити платіж?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Скасувати' }));
    expect(deleteMutateMock).not.toHaveBeenCalled();
  });

  it('відмова сервера при видаленні показується користувачу його текстом', async () => {
    deleteMutateMock.mockRejectedValue(new Error('Платіж уже рознесено'));
    show(tx({ source: 'MANUAL' }));
    render(<BankTransactionsTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Видалити платіж' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Видалити платіж?' })).getByRole('button', {
        name: 'Видалити',
      }),
    );
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Платіж уже рознесено'));
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it.each(['FILE_IMPORT', 'PRIVAT24_API', 'MONOBANK_API'] as const)(
    'рядок із джерела %s не видаляється',
    source => {
      show(tx({ source }));
      render(<BankTransactionsTab />);
      expect(screen.queryByRole('button', { name: 'Видалити платіж' })).not.toBeInTheDocument();
    },
  );

  it('ручний, але вже рознесений рядок не видаляється', () => {
    show(tx({ source: 'MANUAL', status: 'MATCHED', matchedType: 'EXPENSE' }));
    render(<BankTransactionsTab />);
    expect(screen.queryByRole('button', { name: 'Видалити платіж' })).not.toBeInTheDocument();
  });
});

describe('BankTransactionsTab — «Новий платіж»', () => {
  beforeEach(() => {
    useBankTransactionsMock.mockReset();
    show();
  });

  it('кнопка стоїть у рядку пошуку поруч з «Імпорт виписки»', () => {
    render(<BankTransactionsTab />);
    const create = screen.getByRole('button', { name: 'Новий платіж' });
    const importBtn = screen.getByRole('button', { name: /Імпорт виписки/ });
    expect(create.parentElement).toBe(importBtn.parentElement);
    expect(screen.queryByTestId('create')).not.toBeInTheDocument();
  });

  it.each([
    [undefined, 'IN'],
    ['IN', 'IN'],
    ['OUT', 'OUT'],
  ] as const)('вкладка %s → напрям форми за замовчуванням %s', (direction, expected) => {
    render(<BankTransactionsTab direction={direction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Новий платіж' }));
    expect(screen.getByTestId('create')).toHaveAttribute('data-direction', expected);
  });
});
