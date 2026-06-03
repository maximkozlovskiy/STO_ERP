'use client';

import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

export interface BookingRequest {
  id: string;
  status: string;
  clientName: string;
  clientPhone: string;
  requestedDate: string;
  branchId: string;
  branchName?: string | null;
  notes?: string | null;
  createdAt: string;
}

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
