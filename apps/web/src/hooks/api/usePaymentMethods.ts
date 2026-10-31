import { useQuery } from '@tanstack/react-query';
import type { ApiSchema } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

type PaymentMethod = Pick<ApiSchema<'PaymentMethodResponseDto'>, 'code' | 'name'>;

export const paymentMethodsKeys = {
  all: ['payment-methods'] as const,
};

/**
 * Назва способу оплати з довідника (НДІ → «Оплата») за кодом документа. Рядки оплат несуть лише
 * код (`cash`, `bank_transfer`, `<провайдер>_qr`), а людина має бачити «Готівка», а не код. Поки
 * довідник не завантажився або способу немає (видалений) — `null`: показує код той, хто викликає.
 */
export function usePaymentMethodName(code: string | null | undefined): string | null {
  const { employee } = useAuth();
  const { data } = useQuery({
    queryKey: paymentMethodsKeys.all,
    queryFn: ({ signal }) => apiFetch<PaymentMethod[]>('/payment-methods', { signal }),
    enabled: !!employee && !!code,
    staleTime: 5 * 60_000,
  });
  if (!code) return null;
  // Чужа форма відповіді (кеш, мок, стара версія api) — не падати, а показати код.
  return Array.isArray(data) ? (data.find(m => m.code === code)?.name ?? null) : null;
}
