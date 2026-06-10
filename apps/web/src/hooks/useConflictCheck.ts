import { useCallback, useState, useRef } from 'react';
import { apiFetch } from '@/lib/api-client';

export interface ConflictResult {
  liftConflict: boolean;
  employeeConflict: boolean;
  anyConflict: boolean;
  conflictSlots: Array<{ id: string; startAt: string; endAt: string }>;
}

interface CheckParams {
  liftId?: string;
  employeeId?: string;
  startAt: string;
  endAt: string;
  excludeSlotId?: string;
}

export function useConflictCheck(debounceMs = 400) {
  const [conflict, setConflict] = useState<ConflictResult | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const check = useCallback(
    (params: CheckParams) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (!params.startAt || !params.endAt || params.startAt >= params.endAt) {
        setConflict(null);
        return;
      }
      timerRef.current = setTimeout(() => {
        apiFetch<ConflictResult>('/calendar/slots/check-conflicts', {
          method: 'POST',
          body: JSON.stringify(params),
        })
          .then(setConflict)
          .catch(() => setConflict(null));
      }, debounceMs);
    },
    [debounceMs],
  );

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setConflict(null);
  }, []);

  return { conflict, check, clear };
}
