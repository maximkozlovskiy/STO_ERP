// Мутації банківських платежів: URL/метод і які списки збиваються після них.
// Рознесення на оплату постачальнику й зняття готівки змінюють ЧУЖІ списки (оплати постачальникам,
// каса) — без інвалідації вони показували б старе до закінчення staleTime.
//
// Mutation-verify:
//   - прибрати `supplierPaymentsKeys.all` з onSuccess reconcile → кейс SUPPLIER_PAYMENT падає;
//   - прибрати `cashKeys.all` з onSuccess reconcile             → кейс CASH_WITHDRAWAL падає;
//   - `onSettled` → `onSuccess` у reconcile                     → «відмова теж оновлює список» падає.

import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiMultipartFetch: vi.fn(),
}));

import {
  useCreateBankTransaction,
  useDeleteBankTransaction,
  useReconcileBankTransaction,
  useUnreconcileBankTransaction,
  useSupplierPaymentCandidates,
  type ReconcileTransactionInput,
} from '../useBankStatements';

const ID = '11111111-1111-4111-8111-111111111111';

function setup() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  /** Перші елементи ключів, які було збито. */
  const invalidated = () =>
    invalidate.mock.calls.map(c => (c[0] as { queryKey: readonly unknown[] }).queryKey[0]);
  return { wrapper, invalidated };
}

// Блок, а не вираз: mockReset() повертає сам мок, а функцію, повернуту з beforeEach, vitest
// викликає як teardown — мок із відмовою тоді «падав» би вже після тесту.
beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('useReconcileBankTransaction', () => {
  const run = async (data: ReconcileTransactionInput) => {
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useReconcileBankTransaction(), { wrapper });
    act(() => result.current.mutate({ id: 'tx-1', data }));
    await waitFor(() => expect(result.current.isSuccess || result.current.isError).toBe(true));
    return invalidated();
  };

  it('POST …/:id/reconcile з тілом як є', async () => {
    apiFetchMock.mockResolvedValue({});
    await run({ type: 'EXPENSE', expenseCategoryId: ID });
    const [path, init] = apiFetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe('/bank-statements/transactions/tx-1/reconcile');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ type: 'EXPENSE', expenseCategoryId: ID });
  });

  it('SUPPLIER_PAYMENT → збиває і список платежів, і оплати постачальникам', async () => {
    apiFetchMock.mockResolvedValue({});
    const keys = await run({ type: 'SUPPLIER_PAYMENT', counterpartyId: ID });
    expect(keys).toContain('bank-transactions');
    expect(keys).toContain('supplier-payments');
    expect(keys).not.toContain('cash');
  });

  it('CASH_WITHDRAWAL → збиває і список платежів, і касу', async () => {
    apiFetchMock.mockResolvedValue({});
    const keys = await run({ type: 'CASH_WITHDRAWAL', cashRegisterId: ID });
    expect(keys).toContain('bank-transactions');
    expect(keys).toContain('cash');
    expect(keys).not.toContain('supplier-payments');
  });

  it('вид без проведень (EXPENSE) чужих списків не чіпає', async () => {
    apiFetchMock.mockResolvedValue({});
    expect(await run({ type: 'EXPENSE', expenseCategoryId: ID })).toEqual(['bank-transactions']);
  });

  it('відмова (409 «уже рознесено») теж оновлює список платежів — рядок у ньому застарів', async () => {
    apiFetchMock.mockRejectedValue(new Error('Платіж уже рознесено'));
    expect(await run({ type: 'SUPPLIER_PAYMENT', supplierPaymentId: ID })).toEqual([
      'bank-transactions',
    ]);
  });
});

describe('інші мутації банківських платежів', () => {
  it('create: POST /bank-statements/transactions із заголовком Idempotency-Key', async () => {
    apiFetchMock.mockResolvedValue({});
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useCreateBankTransaction(), { wrapper });
    const data = {
      bankAccountId: ID,
      direction: 'OUT' as const,
      amount: 10,
      operationDate: '2026-10-09',
    };
    await act(async () => {
      await result.current.mutateAsync({ data, idempotencyKey: 'key-123' });
    });
    const [path, init] = apiFetchMock.mock.calls[0] as [
      string,
      { method: string; body: string; headers: Record<string, string> },
    ];
    expect(path).toBe('/bank-statements/transactions');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Idempotency-Key': 'key-123' });
    expect(JSON.parse(init.body)).toEqual(data);
    expect(invalidated()).toEqual(['bank-transactions']);
  });

  it('delete: DELETE /bank-statements/transactions/:id', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useDeleteBankTransaction(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('tx-7');
    });
    expect(apiFetchMock).toHaveBeenCalledWith('/bank-statements/transactions/tx-7', {
      method: 'DELETE',
    });
    expect(invalidated()).toEqual(['bank-transactions']);
  });

  it('unreconcile: POST …/:id/unreconcile з причиною; збиває платежі, касу й оплати постачальникам', async () => {
    apiFetchMock.mockResolvedValue({});
    const { wrapper, invalidated } = setup();
    const { result } = renderHook(() => useUnreconcileBankTransaction(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'tx-7', reason: 'дубль' });
    });
    const [path, init] = apiFetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe('/bank-statements/transactions/tx-7/unreconcile');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ reason: 'дубль' });
    expect([...invalidated()].sort()).toEqual(['bank-transactions', 'cash', 'supplier-payments']);
  });

  it('кандидати оплат: без id рядка або з enabled=false запит не йде', () => {
    const { wrapper } = setup();
    renderHook(() => useSupplierPaymentCandidates(null), { wrapper });
    renderHook(() => useSupplierPaymentCandidates('tx-1', false), { wrapper });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('кандидати оплат: GET …/:id/supplier-payment-candidates із сигналом скасування', async () => {
    apiFetchMock.mockResolvedValue([]);
    const { wrapper } = setup();
    renderHook(() => useSupplierPaymentCandidates('tx-1'), { wrapper });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const [path, init] = apiFetchMock.mock.calls[0] as [string, { signal?: AbortSignal }];
    expect(path).toBe('/bank-statements/transactions/tx-1/supplier-payment-candidates');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
