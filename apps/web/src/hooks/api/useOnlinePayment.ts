import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface OnlineIntent {
  id: string;
  status: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';
  pageUrl: string | null;
  amount: number;
  paymentId: string | null;
  error: string | null;
}

/** Створити QR-намір оплати для рахунку (активний шлюз філії: monobank/LiqPay). */
export function useCreateOnlinePayment() {
  return useMutation({
    mutationFn: (data: { invoiceId: string; amount?: number }) =>
      apiFetch<OnlineIntent>('/online-payments', { method: 'POST', body: JSON.stringify(data) }),
  });
}

/**
 * Polling статусу наміру. enabled поки intentId є І статус PENDING — на терміналі зупиняємось,
 * щоб не лити запити вічно. refetchInterval 3s.
 */
export function useOnlineIntentStatus(intentId: string | null, active: boolean) {
  return useQuery({
    queryKey: ['online-payments', 'detail', intentId],
    queryFn: () => apiFetch<OnlineIntent>(`/online-payments/${intentId}`),
    enabled: !!intentId && active,
    refetchInterval: active ? 3000 : false,
    staleTime: 0,
  });
}
