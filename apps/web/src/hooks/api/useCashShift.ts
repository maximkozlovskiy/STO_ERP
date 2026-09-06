import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface CashShift {
  id: string;
  status: 'OPEN' | 'CLOSED';
  cashRegisterId: string;
  cashRegisterName?: string;
  checkboxShiftId: string | null;
  openedAt: string;
  closedAt: string | null;
  zReportId: string | null;
  pendingReceipts?: number;
}

export const cashShiftKeys = {
  all: ['cash-shifts'] as const,
  current: (branchId: string) => [...cashShiftKeys.all, 'current', branchId] as const,
};

/** Поточна відкрита зміна філії (null якщо закрита). */
export function useCurrentShift(branchId: string | null) {
  return useQuery({
    queryKey: branchId ? cashShiftKeys.current(branchId) : [...cashShiftKeys.all, 'current', null],
    queryFn: () => apiFetch<CashShift | null>(`/cash-shifts/current?branchId=${branchId}`),
    enabled: !!branchId,
    staleTime: 15_000,
  });
}

export function useOpenShift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (branchId: string) =>
      apiFetch<CashShift>(`/cash-shifts/open?branchId=${branchId}`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: cashShiftKeys.all }),
  });
}

export function useCloseShift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<CashShift>(`/cash-shifts/${id}/close`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: cashShiftKeys.all }),
  });
}
