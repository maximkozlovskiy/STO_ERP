import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import type { ApiSchema } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

/**
 * Заявка на онлайн-запис — ЗГЕНЕРОВАНИЙ тип із OpenAPI.
 * Копія мала `status: string`; колонка в БД справді `String`, але сервіс пише
 * рівно PENDING/CONFIRMED/CANCELLED — DTO це тепер оголошує явно.
 */
export type BookingRequest = ApiSchema<'BookingRequestResponseDto'>;
export type BookingRequestStatusValue = BookingRequest['status'];

export const bookingKeys = {
  all: ['booking'] as const,
  list: () => [...bookingKeys.all, 'list'] as const,
};

export function useBookingRequests() {
  const { employee } = useAuth();
  return useQuery<BookingRequest[]>({
    queryKey: bookingKeys.list(),
    queryFn: ({ signal }) =>
      apiFetch<{ items: BookingRequest[]; total: number }>('/booking', { signal }).then(
        r => r.items ?? [],
      ),
    enabled: !!employee,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useInvalidateBookings() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: bookingKeys.all });
}
