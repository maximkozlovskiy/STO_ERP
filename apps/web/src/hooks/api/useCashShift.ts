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
  current: (branchId: string, cashRegisterId: string) =>
    [...cashShiftKeys.all, 'current', branchId, cashRegisterId] as const,
};

/**
 * Поточна відкрита зміна КАСИ (null якщо закрита). Зміна своя в кожної фіскальної каси
 * (BR-CASH-027): без id каси сервер віддав би зміну будь-якої каси філії.
 */
export function useCurrentShift(branchId: string | null, cashRegisterId: string | null) {
  return useQuery({
    queryKey:
      branchId && cashRegisterId
        ? cashShiftKeys.current(branchId, cashRegisterId)
        : [...cashShiftKeys.all, 'current', null],
    queryFn: () =>
      apiFetch<CashShift | null>(
        `/cash-shifts/current?branchId=${branchId}&cashRegisterId=${cashRegisterId}`,
      ),
    enabled: !!branchId && !!cashRegisterId,
    staleTime: 15_000,
  });
}

/** Відкрити зміну саме на цій касі (без id каси сервер відкрив би найстарішу касу філії). */
export function useOpenShift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ branchId, cashRegisterId }: { branchId: string; cashRegisterId: string }) =>
      apiFetch<CashShift>(
        `/cash-shifts/open?branchId=${branchId}&cashRegisterId=${cashRegisterId}`,
        { method: 'POST' },
      ),
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
