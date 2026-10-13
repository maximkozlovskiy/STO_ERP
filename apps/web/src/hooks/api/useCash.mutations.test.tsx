// Мутації каси: касова операція з контрагентом рухає не лише касу.
//
//   - POST /cash-registers/:id/operations несе тіло як є та заголовок `Idempotency-Key`;
//   - після успіху скидаються кеші каси, оплат (рахунки, наряди, баланс контрагента) і
//     закупівель (замовлення, оплати постачальникам) — інакше «Оплачено» в рахунку чи
//     замовленні з'являлось би лише після staleTime;
//   - повтор фіскального чека йде на POST /payments/:id/retry-fiscal і оновлює історію каси.
//
// Mutation-verify:
//   - прибрати `invalidatePurchaseSideEffects(qc)` → кейс «закупівлі» падає;
//   - прибрати `invalidatePaymentSideEffects(qc)`  → кейс «оплати» падає;
//   - прибрати `headers: { 'Idempotency-Key': … }` → кейс заголовка падає.

import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { useCreateCashOperation, useRetryCashFiscal } from './useCash';

function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  /** Перші сегменти всіх інвалідованих ключів. */
  const roots = () =>
    new Set(invalidate.mock.calls.map(c => String((c[0]?.queryKey as unknown[] | undefined)?.[0])));
  return { wrapper, roots };
}

const CP = '11111111-1111-4111-8111-111111111111';

describe('useCreateCashOperation', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ id: 'op-1' });
  });

  it('POST на операції каси: тіло без id каси й ключа, ключ — у заголовку', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useCreateCashOperation(), { wrapper });
    await act(() =>
      result.current.mutateAsync({
        cashRegisterId: 'reg-1',
        idempotencyKey: 'key-1',
        direction: 'IN',
        reason: 'SALE_PAYMENT',
        amount: 500,
        counterpartyId: CP,
      }),
    );
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0]! as [
      string,
      { method: string; body: string; headers?: Record<string, string> },
    ];
    expect(path).toBe('/cash-registers/reg-1/operations');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Idempotency-Key': 'key-1' });
    expect(JSON.parse(init.body)).toEqual({
      direction: 'IN',
      reason: 'SALE_PAYMENT',
      amount: 500,
      counterpartyId: CP,
    });
  });

  it('після успіху скидає касу, оплати й закупівлі', async () => {
    const { wrapper, roots } = setup();
    const { result } = renderHook(() => useCreateCashOperation(), { wrapper });
    await act(() =>
      result.current.mutateAsync({
        cashRegisterId: 'reg-1',
        direction: 'OUT',
        reason: 'SUPPLIER_PAYMENT',
        amount: 100,
        counterpartyId: CP,
      }),
    );
    const keys = roots();
    expect(keys).toContain('cash');
    // оплата контрагента: рахунки, наряди, оплати, баланс контрагента
    for (const k of ['invoices', 'work-orders', 'payments', 'counterparties']) {
      expect(keys).toContain(k);
    }
    // оплата постачальнику: замовлення й оплати постачальникам
    for (const k of ['purchase-orders', 'supplier-payments']) {
      expect(keys).toContain(k);
    }
  });

  it('відмова сервера нічого не скидає', async () => {
    apiFetchMock.mockRejectedValue(new Error('403'));
    const { wrapper, roots } = setup();
    const { result } = renderHook(() => useCreateCashOperation(), { wrapper });
    await act(async () => {
      await result.current
        .mutateAsync({ cashRegisterId: 'reg-1', direction: 'OUT', reason: 'MANUAL_OUT', amount: 1 })
        .catch(() => undefined);
    });
    expect(roots().size).toBe(0);
  });
});

describe('useRetryCashFiscal', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ id: 'p1', fiscalStatus: 'QUEUED' });
  });

  it('POST /payments/:id/retry-fiscal і оновлення історії каси', async () => {
    const { wrapper, roots } = setup();
    const { result } = renderHook(() => useRetryCashFiscal(), { wrapper });
    await act(() => result.current.mutateAsync('p1'));
    expect(apiFetchMock).toHaveBeenCalledWith('/payments/p1/retry-fiscal', { method: 'POST' });
    expect(roots()).toContain('cash');
    expect(roots()).toContain('payments');
  });
});
