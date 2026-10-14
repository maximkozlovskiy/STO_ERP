// Сторно в історії каси (BR-CASH-023).
//
// Що стереже:
//   - дія «Сторнувати» — лише ролям зі сторно (власник / адміністратор / бухгалтер); приймальня
//     й роль без операцій не мають ні кнопки, ні колонки дій;
//   - немає дії в рядка, вже сторнованого (`reversedBy`), у рядка сторно (`reversalOfId`) і в
//     рядків, створених зарплатою (`PayrollPeriod`) чи банком (`BankTransaction`);
//   - оригінал: сума закреслена, позначка «Сторновано: причина, дата»; рядок сторно —
//     «Сторно: <привід>», посилання на оригінал із його датою й сумою, сума зі знаком напряму;
//   - клік по посиланню прокручує до оригіналу й підсвічує його; оригінал поза відбором —
//     текст «оригінал поза відбором»;
//   - «Повторити» чек не пропонується для сторнованої оплати;
//   - кнопка відкриває картку сторно саме цього рядка.
//
// Mutation-verify:
//   - прибрати `!op.reversedBy` з `isReversible` → «вже сторнований» падає;
//   - прибрати `!op.reversalOfId` з `isReversible` → «рядок сторно» падає;
//   - прибрати 'BankTransaction' з NOT_REVERSIBLE_HERE → «зарплата й банк» падає;
//   - `{canOperate && (` перед кнопкою → `{(` → «приймальня» падає;
//   - прибрати `reversed && 'line-through …'` → «оригінал закреслений» падає.

import { render, screen, fireEvent, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { CashOperation } from '@/hooks/api/useCash';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/format', () => ({
  fmtMoney: (v: number) => String(v),
  fmtDateTime: (v: string) => `дата ${v.slice(0, 10)}`,
  kyivToday: () => '2026-10-14',
}));
vi.mock('@/components/ui/date-picker-input', () => ({ DatePickerInput: () => null }));
vi.mock('@/lib/linked-nav', () => ({
  useLinkedNav: () => ({ toWorkOrder: vi.fn(), toPurchaseOrder: vi.fn() }),
}));

let operations: CashOperation[] = [];
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
  useCashOperations: () => ({ data: operations, isLoading: false }),
  useCreateCashOperation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRetryCashFiscal: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReverseCashOperation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
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

const op = (over: Partial<CashOperation>): CashOperation => ({
  id: 'op',
  cashRegisterId: 'reg-1',
  direction: 'IN',
  amount: 100,
  reason: 'MANUAL_IN',
  createdAt: '2026-10-14T09:00:00.000Z',
  ...over,
});

/** Оплата контрагента 500 ₴ від 10.10, сторнована рядком `rev` 14.10. */
const ORIGINAL = op({
  id: 'orig',
  reason: 'SALE_PAYMENT',
  amount: 500,
  counterpartyName: 'Коваль Олег',
  documentType: 'Payment',
  documentId: 'pay-1',
  fiscalStatus: 'FAILED',
  createdAt: '2026-10-10T09:00:00.000Z',
  reversedBy: { id: 'rev', createdAt: '2026-10-14T12:00:00.000Z', reason: 'помилкова сума' },
});
const REVERSAL = op({
  id: 'rev',
  direction: 'OUT',
  reason: 'SALE_PAYMENT',
  amount: 500,
  counterpartyName: 'Коваль Олег',
  notes: 'помилкова сума',
  createdAt: '2026-10-14T12:00:00.000Z',
  reversalOfId: 'orig',
});

const rowById = (id: string) => document.getElementById(`cash-op-${id}`) as HTMLElement;
const reverseButtons = () => screen.queryAllByRole('button', { name: 'Сторнувати' });

describe('CashOperationsTab — дія «Сторнувати»', () => {
  beforeEach(() => {
    operations = [];
  });

  it('власник / адміністратор / бухгалтер: кнопка в рядку звичайної операції', () => {
    operations = [op({ id: 'plain' })];
    render(<CashOperationsTab canOperate />);
    expect(within(rowById('plain')).getByRole('button', { name: 'Сторнувати' })).toBeVisible();
  });

  it('приймальня й роль без операцій: ні кнопки, ні колонки дій', () => {
    operations = [op({ id: 'plain' })];
    const { unmount } = render(<CashOperationsTab receptionist />);
    expect(reverseButtons()).toHaveLength(0);
    expect(screen.queryByRole('columnheader', { name: 'Дії' })).toBeNull();
    unmount();

    render(<CashOperationsTab />);
    expect(reverseButtons()).toHaveLength(0);
    expect(screen.queryByRole('columnheader', { name: 'Дії' })).toBeNull();
  });

  it('вже сторнований рядок і сам рядок сторно — без кнопки', () => {
    operations = [ORIGINAL, REVERSAL, op({ id: 'plain' })];
    render(<CashOperationsTab canOperate />);
    expect(within(rowById('orig')).queryByRole('button', { name: 'Сторнувати' })).toBeNull();
    expect(within(rowById('rev')).queryByRole('button', { name: 'Сторнувати' })).toBeNull();
    expect(reverseButtons()).toHaveLength(1);
  });

  it('зарплата й банк — без кнопки (їх скасовують у відомості та виписці)', () => {
    operations = [
      op({ id: 'payroll', direction: 'OUT', reason: 'PAYROLL', documentType: 'PayrollPeriod' }),
      op({ id: 'bank', reason: 'BANK_WITHDRAWAL', documentType: 'BankTransaction' }),
      op({
        id: 'supplier',
        direction: 'OUT',
        reason: 'SUPPLIER_PAYMENT',
        documentType: 'SupplierPayment',
      }),
    ];
    render(<CashOperationsTab canOperate />);
    expect(within(rowById('payroll')).queryByRole('button', { name: 'Сторнувати' })).toBeNull();
    expect(within(rowById('bank')).queryByRole('button', { name: 'Сторнувати' })).toBeNull();
    expect(within(rowById('supplier')).getByRole('button', { name: 'Сторнувати' })).toBeVisible();
  });

  it('кнопка відкриває картку сторно саме цього рядка', () => {
    operations = [
      op({ id: 'a', amount: 111, counterpartyName: 'Клієнт А', reason: 'SALE_PAYMENT' }),
      op({ id: 'b', amount: 222, counterpartyName: 'Клієнт Б', reason: 'SALE_PAYMENT' }),
    ];
    render(<CashOperationsTab canOperate />);
    fireEvent.click(within(rowById('b')).getByRole('button', { name: 'Сторнувати' }));
    const summary = screen.getByRole('region', { name: 'Що сторнується' });
    expect(within(summary).getByText('222 ₴')).toBeInTheDocument();
    expect(within(summary).getByText('Клієнт Б')).toBeInTheDocument();
  });
});

describe('CashOperationsTab — позначки сторно', () => {
  beforeEach(() => {
    operations = [];
  });

  it('оригінал: сума закреслена, «Сторновано: причина, дата», без «Повторити» чека', () => {
    operations = [REVERSAL, ORIGINAL];
    render(<CashOperationsTab canOperate />);
    const row = rowById('orig');
    expect(row).toHaveAttribute('data-reversed', 'true');
    expect(
      within(row).getByText('Сторновано: помилкова сума, дата 2026-10-14'),
    ).toBeInTheDocument();
    const amount = within(row).getByText(/\+500/);
    expect(amount.className).toContain('line-through');
    expect(within(row).queryByRole('button', { name: 'Повторити' })).toBeNull();
  });

  it('рядок сторно: «Сторно: <привід>», сума зі знаком напряму, посилання на оригінал', () => {
    operations = [REVERSAL, ORIGINAL];
    render(<CashOperationsTab canOperate />);
    const row = rowById('rev');
    expect(row).toHaveAttribute('data-reversal', 'true');
    expect(within(row).getByText(/^Сторно: Оплата контрагента/)).toBeInTheDocument();
    const amount = within(row).getByText(/−500/);
    expect(amount.className).not.toContain('line-through');
    expect(
      within(row).getByRole('button', {
        name: 'Показати сторновану операцію від дата 2026-10-10',
      }),
    ).toHaveTextContent('оригінал від дата 2026-10-10, 500 ₴');
  });

  it('клік по посиланню прокручує до оригіналу й підсвічує його', () => {
    operations = [REVERSAL, ORIGINAL];
    render(<CashOperationsTab canOperate />);
    const original = rowById('orig');
    const scroll = vi.fn();
    original.scrollIntoView = scroll;
    fireEvent.click(
      within(rowById('rev')).getByRole('button', {
        name: 'Показати сторновану операцію від дата 2026-10-10',
      }),
    );
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(rowById('orig').className).toContain('bg-warning-subtle');
    expect(rowById('rev').className).not.toContain('bg-warning-subtle');
  });

  it('позначка оригіналу веде до рядка сторно', () => {
    operations = [REVERSAL, ORIGINAL];
    render(<CashOperationsTab canOperate />);
    const reversal = rowById('rev');
    const scroll = vi.fn();
    reversal.scrollIntoView = scroll;
    fireEvent.click(within(rowById('orig')).getByRole('button', { name: /^Сторновано:/ }));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(rowById('rev').className).toContain('bg-warning-subtle');
  });

  it('оригінал поза відбором: текст замість посилання; рядок сторно поза відбором — позначка без посилання', () => {
    operations = [
      op({ ...REVERSAL, id: 'rev-only', reversalOfId: 'not-loaded' }),
      op({
        ...ORIGINAL,
        id: 'orig-only',
        counterpartyName: 'Інший',
        reversedBy: {
          id: 'not-loaded-rev',
          createdAt: '2026-10-13T08:00:00.000Z',
          reason: 'дубль',
        },
      }),
    ];
    render(<CashOperationsTab canOperate />);
    expect(within(rowById('rev-only')).getByText('оригінал поза відбором')).toBeInTheDocument();
    expect(
      within(rowById('rev-only')).queryByRole('button', { name: /Показати сторновану/ }),
    ).toBeNull();
    expect(
      within(rowById('orig-only')).getByText('Сторновано: дубль, дата 2026-10-13'),
    ).toBeInTheDocument();
    expect(within(rowById('orig-only')).queryByRole('button', { name: /^Сторновано:/ })).toBeNull();
  });
});
