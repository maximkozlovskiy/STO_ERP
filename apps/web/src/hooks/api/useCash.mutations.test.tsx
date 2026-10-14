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

import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import {
  useBaseCurrency,
  useCashOperations,
  useCreateCashOperation,
  useRetryCashFiscal,
  useReverseCashOperation,
} from './useCash';

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

  // Відмова не доводить, що нічого не сталось: відповідь могла не дійти, а операція — пройти.
  // Тому історію й залишок каси перечитуємо; оплати й закупівлі не чіпаємо.
  it('після відмови перечитує лише касу (історію й залишок)', async () => {
    apiFetchMock.mockRejectedValue(new Error('403'));
    const { wrapper, roots } = setup();
    const { result } = renderHook(() => useCreateCashOperation(), { wrapper });
    await act(async () => {
      await result.current
        .mutateAsync({ cashRegisterId: 'reg-1', direction: 'OUT', reason: 'MANUAL_OUT', amount: 1 })
        .catch(() => undefined);
    });
    expect([...roots()]).toEqual(['cash']);
  });
});

// Сторно касової операції (BR-CASH-023…025): відкочує оплату контрагента (рахунок, наряд,
// борг) або оплату постачальнику (замовлення, статус оплати) — скидаються обидва дерева.
// Mutation-verify: прибрати `invalidatePaymentSideEffects` з `invalidateCashReversalSideEffects`
// → кейс «скидає» падає; прибрати `headers` → кейс заголовка падає.
describe('useReverseCashOperation', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ id: 'op-rev', reversalOfId: 'op-1' });
  });

  const reverse = { cashRegisterId: 'reg-1', operationId: 'op-1', idempotencyKey: 'key-9' };

  it('POST …/operations/:operationId/reverse: тіло — лише причина, ключ — у заголовку', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useReverseCashOperation(), { wrapper });
    await act(() => result.current.mutateAsync({ ...reverse, reason: 'помилкова сума' }));
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0]! as [
      string,
      { method: string; body: string; headers?: Record<string, string> },
    ];
    expect(path).toBe('/cash-registers/reg-1/operations/op-1/reverse');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Idempotency-Key': 'key-9' });
    expect(JSON.parse(init.body)).toEqual({ reason: 'помилкова сума' });
  });

  it('після успіху скидає касу, оплати, рахунки, наряди, контрагентів і закупівлі', async () => {
    const { wrapper, roots } = setup();
    const { result } = renderHook(() => useReverseCashOperation(), { wrapper });
    await act(() => result.current.mutateAsync({ ...reverse, reason: 'дубль' }));
    const keys = roots();
    for (const k of [
      'cash',
      'invoices',
      'work-orders',
      'payments',
      'counterparties',
      'purchase-orders',
      'supplier-payments',
    ]) {
      expect(keys).toContain(k);
    }
  });

  it('після відмови перечитує лише касу', async () => {
    apiFetchMock.mockRejectedValue(new Error('Операцію вже сторновано'));
    const { wrapper, roots } = setup();
    const { result } = renderHook(() => useReverseCashOperation(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ ...reverse, reason: 'x' }).catch(() => undefined);
    });
    expect([...roots()]).toEqual(['cash']);
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

// Bug #847: базову валюту читає кожна роль, що бачить касу; /settings/organisation відкритий
// лише власнику й адміністратору (бухгалтер і приймальня отримували 403).
describe('useBaseCurrency', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) =>
      path === '/currencies'
        ? Promise.resolve({ items: [{ code: 'USD', symbol: '$' }], total: 1 })
        : Promise.resolve({ currency: 'USD' }),
    );
  });

  it('код валюти бере з маршруту для всіх ролей, а не з повних налаштувань організації', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useBaseCurrency(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ code: 'USD', symbol: '$' }));
    const paths = apiFetchMock.mock.calls.map(c => c[0] as string);
    expect(paths).toContain('/settings/base-currency');
    expect(paths).not.toContain('/settings/organisation');
  });
});

// Bug #849: без `limit` сервер віддає 100 рядків — історія каси мовчки обрізалась.
describe('useCashOperations', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue([]);
  });

  it('межа рядків іде в запит разом із відбором', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    renderHook(() => useCashOperations('reg-1', { q: 'коваль', dateFrom: '2026-10-14' }, 500), {
      wrapper,
    });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const path = apiFetchMock.mock.calls[0]![0] as string;
    expect(path.startsWith('/cash-registers/reg-1/operations?')).toBe(true);
    const query = new URLSearchParams(path.split('?')[1]);
    expect(query.get('limit')).toBe('500');
    expect(query.get('dateFrom')).toBe('2026-10-14');
    expect(query.get('q')).toBe('коваль');
  });
});
