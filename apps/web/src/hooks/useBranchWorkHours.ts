'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import {
  DEFAULT_WORK_HOURS_WINDOW,
  type WorkHoursWindow,
} from '@/components/ui/work-order/planned-dates';

interface WorkHoursResponse {
  workStartHour: number;
  workEndHour: number;
}

// Години філії змінюються рідко (сервер тримає їх у кеші 60 с) — одне читання на хвилину на
// філію, а не на кожне відкриття картки наряду.
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: Promise<WorkHoursWindow> }>();

function isHours(v: unknown): v is WorkHoursResponse {
  const r = v as WorkHoursResponse | null;
  return (
    !!r &&
    Number.isInteger(r.workStartHour) &&
    Number.isInteger(r.workEndHour) &&
    r.workStartHour >= 0 &&
    r.workEndHour <= 24 &&
    r.workEndHour > r.workStartHour
  );
}

function load(branchId: string): Promise<WorkHoursWindow> {
  const hit = cache.get(branchId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = apiFetch<unknown>(`/settings/work-hours?branchId=${encodeURIComponent(branchId)}`)
    .then(r =>
      isHours(r)
        ? { startHour: r.workStartHour, endHour: r.workEndHour }
        : { ...DEFAULT_WORK_HOURS_WINDOW },
    )
    .catch(() => {
      cache.delete(branchId); // збій — наступне відкриття спробує ще раз
      return { ...DEFAULT_WORK_HOURS_WINDOW };
    });
  cache.set(branchId, { at: Date.now(), value });
  return value;
}

/** Лише для тестів: скинути кеш між кейсами (`isolate: false`). */
export function resetBranchWorkHoursCache(): void {
  cache.clear();
}

/**
 * Робочі години філії для пікера планових дат наряду й автокінця (BR-WO-019) — той самий
 * `GET /settings/work-hours?branchId=`, що й сервер, який перевіряє дати. Доки не завантажено
 * чи філію не обрано — типові 09–18, як на сервері.
 */
export function useBranchWorkHours(branchId: string | null | undefined): WorkHoursWindow {
  const [hours, setHours] = useState<WorkHoursWindow>(DEFAULT_WORK_HOURS_WINDOW);
  useEffect(() => {
    if (!branchId) {
      setHours(DEFAULT_WORK_HOURS_WINDOW);
      return;
    }
    let cancelled = false;
    void load(branchId).then(h => {
      if (cancelled) return;
      setHours(prev => (prev.startHour === h.startHour && prev.endHour === h.endHour ? prev : h));
    });
    return () => {
      cancelled = true;
    };
  }, [branchId]);
  return hours;
}
