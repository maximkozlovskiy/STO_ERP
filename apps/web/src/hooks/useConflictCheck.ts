import { useCallback, useEffect, useState, useRef } from 'react';
import { apiFetch } from '@/lib/api-client';

export interface ConflictSlot {
  id: string;
  startAt: string;
  endAt: string;
  liftId?: string | null;
  employeeId?: string | null;
  workOrderId?: string | null;
  vehicleId?: string | null;
  counterpartyId?: string | null;
  parentSlotId?: string | null;
  notes?: string | null;
  workOrderNumber?: string;
  counterpartyName?: string;
  cpPhone?: string | null;
  vehicleSummary?: string | null;
  vehiclePlate?: string | null;
  status: string;
  type: string;
}

export interface ConflictResult {
  liftConflict: boolean;
  employeeConflict: boolean;
  anyConflict: boolean;
  conflictSlots: ConflictSlot[];
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
  // Token-ref: кожен check() інкрементує лічильник; pending fetch ігнорує
  // setConflict якщо токен застарів (швидкі зміни liftId / часу → остання-запитана
  // не остання-зарезолвлена партія). + mountedRef блокує setState після unmount.
  const reqIdRef = useRef(0);
  const mountedRef = useRef(true);

  // Component-level unmount cleanup: clearTimeout щоб debounce-фаза що ще не
  // встигла відправити fetch не запускала apiFetch після unmount (memory leak +
  // race з потенційним setConflict на розмонтованому компоненті).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const check = useCallback(
    (params: CheckParams) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (!params.startAt || !params.endAt || params.startAt >= params.endAt) {
        if (mountedRef.current) setConflict(null);
        return;
      }
      const reqId = ++reqIdRef.current;
      timerRef.current = setTimeout(() => {
        apiFetch<ConflictResult>('/calendar/slots/check-conflicts', {
          method: 'POST',
          body: JSON.stringify(params),
        })
          .then(res => {
            if (!mountedRef.current || reqId !== reqIdRef.current) return;
            setConflict(res);
          })
          .catch(() => {
            if (!mountedRef.current || reqId !== reqIdRef.current) return;
            setConflict(null);
          });
      }, debounceMs);
    },
    [debounceMs],
  );

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    // Інкрементуємо токен — pending in-flight fetch ігнорується
    reqIdRef.current++;
    if (mountedRef.current) setConflict(null);
  }, []);

  return { conflict, check, clear };
}
