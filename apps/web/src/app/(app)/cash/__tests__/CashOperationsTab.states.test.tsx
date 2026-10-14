// Стани вкладки «Операції», яких не видно на маленькій касі.
//
//   - Bug #849: історія просить у сервера його стелю (500 рядків, BR-CASH-015), а не типові 100,
//     і каже, коли старіші операції не вмістились;
//
// Mutation-verify:
//   - прибрати третій аргумент `CASH_HISTORY_LIMIT` у `useCashOperations(…)` → «просить стелю» падає;
//   - прибрати блок `historyTruncated && …`                                  → «каже, що обрізано» падає;
//   - `>= CASH_HISTORY_LIMIT` → `> CASH_HISTORY_LIMIT`                        → «каже, що обрізано» падає.

import { render, screen } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { CashOperation, CashRegister } from '@/hooks/api/useCash';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/format', () => ({
  fmtMoney: (v: number) => String(v),
  fmtDateTime: (v: string) => v,
  kyivToday: () => '2026-10-14',
}));
vi.mock('@/components/ui/date-picker-input', () => ({ DatePickerInput: () => null }));
vi.mock('@/lib/linked-nav', () => ({ useLinkedNav: () => ({}) }));

const REGISTER = {
  id: 'reg-1',
  name: 'Каса №1',
  branchId: 'br-1',
  currencyCode: 'UAH',
  currencySymbol: '₴',
  isFiscal: false,
  initialBalance: 0,
  balance: 0,
} as CashRegister;

const state = vi.hoisted(() => ({
  registers: undefined as unknown,
  registersError: null as Error | null,
  refetchRegisters: vi.fn(),
  operations: [] as unknown[],
  operationsArgs: [] as unknown[][],
}));
vi.mock('@/hooks/api/useCash', () => ({
  useCashRegisters: () => ({
    data: state.registers,
    isLoading: false,
    error: state.registersError,
    refetch: state.refetchRegisters,
  }),
  useCashOperations: (...args: unknown[]) => {
    state.operationsArgs.push(args);
    return { data: state.operations, isLoading: false };
  },
  useCreateCashOperation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRetryCashFiscal: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

import CashOperationsTab, { CASH_HISTORY_LIMIT } from '../CashOperationsTab';

const rows = (n: number): CashOperation[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `op-${i}`,
    cashRegisterId: 'reg-1',
    direction: 'IN',
    amount: 1,
    reason: 'MANUAL_IN',
    createdAt: '2026-10-14T09:00:00.000Z',
  })) as CashOperation[];

const TRUNCATED = /Показано останні 500 операцій/;

describe('CashOperationsTab — межа історії (Bug #849)', () => {
  beforeEach(() => {
    state.registers = [REGISTER];
    state.registersError = null;
    state.refetchRegisters.mockReset();
    state.operations = [];
    state.operationsArgs = [];
  });

  it('історія просить у сервера його стелю рядків, а не типові 100', () => {
    render(<CashOperationsTab canOperate />);
    expect(CASH_HISTORY_LIMIT).toBe(500);
    expect(state.operationsArgs.at(-1)?.[2]).toBe(CASH_HISTORY_LIMIT);
  });

  it('прийшло рівно стільки, скільки просили → каже, що старіші операції не вмістились', () => {
    state.operations = rows(CASH_HISTORY_LIMIT);
    render(<CashOperationsTab canOperate />);
    expect(screen.getByRole('status')).toHaveTextContent(TRUNCATED);
  });

  it('рядків менше за стелю → жодного попередження', () => {
    state.operations = rows(CASH_HISTORY_LIMIT - 1);
    render(<CashOperationsTab canOperate />);
    expect(screen.queryByText(TRUNCATED)).toBeNull();
  });
});
