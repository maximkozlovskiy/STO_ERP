// Сторно безготівкової оплати (BR-PAY-024): хук `useReversePayment`.
//
//   - POST /payments/:id/reverse: тіло — рівно `{ reason }`, ключ — у заголовку `Idempotency-Key`;
//   - після будь-якого результату скидаються кеші оплат (каса, рахунки, наряди, баланс) і
//     банківських платежів — рядок виписки сторнованої оплати став «Нерознесений»; відмова не
//     доводить, що сторно не пройшло (відповідь могла не дійти).
//
// Mutation-verify:
//   - прибрати `invalidateQueries(bankTransactionsKeys.all)` → «банківські платежі» падає;
//   - `onSettled` → `onSuccess` → «після відмови» падає.

import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiMultipartFetch: vi.fn(),
}));

import { useReversePayment } from './useBankStatements';

function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const roots = () =>
    new Set(invalidate.mock.calls.map(c => String((c[0]?.queryKey as unknown[] | undefined)?.[0])));
  return { wrapper, roots };
}

describe('useReversePayment (BR-PAY-024)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  // guards: BR-PAY-024
  it('POST /payments/:id/reverse з { reason } і Idempotency-Key; скидає оплати й банківські платежі', async () => {
    apiFetchMock.mockResolvedValue({ id: 'pay-1' });
    const { wrapper, roots } = setup();
    const { result } = renderHook(() => useReversePayment(), { wrapper });
    await act(() =>
      result.current.mutateAsync({
        paymentId: 'pay-1',
        idempotencyKey: 'key-1',
        reason: 'помилка',
      }),
    );
    expect(apiFetchMock).toHaveBeenCalledWith('/payments/pay-1/reverse', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'key-1' },
      body: JSON.stringify({ reason: 'помилка' }),
    });
    for (const root of ['bank-transactions', 'cash', 'invoices', 'work-orders', 'payments']) {
      expect(roots()).toContain(root);
    }
  });

  // guards: BR-PAY-024
  it('після відмови теж скидає кеші — відповідь могла не дійти, а сторно пройти', async () => {
    apiFetchMock.mockRejectedValue(new Error('мережа'));
    const { wrapper, roots } = setup();
    const { result } = renderHook(() => useReversePayment(), { wrapper });
    await act(async () => {
      await result.current
        .mutateAsync({ paymentId: 'pay-1', idempotencyKey: 'key-1', reason: 'помилка' })
        .catch(() => undefined);
    });
    expect(roots()).toContain('bank-transactions');
    expect(roots()).toContain('work-orders');
  });
});
