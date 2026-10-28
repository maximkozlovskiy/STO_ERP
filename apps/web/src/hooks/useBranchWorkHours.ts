'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import {
  DEFAULT_WORK_HOURS_WINDOW,
  type WorkHoursWindow,
} from '@/components/ui/work-order/planned-dates';

interface WorkHoursResponse {
  workStartHour: number;
  workEndHour: number;
}

/**
 * Ключі кешу робочих годин: `all` — для скидання після збереження годин філії в налаштуваннях;
 * `null` замість філії — основна філія організації (`GET /settings/work-hours` без `branchId`).
 */
export const workHoursKeys = {
  all: ['settings', 'work-hours'] as const,
  branch: (branchId: string | null) => ['settings', 'work-hours', branchId] as const,
};

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

async function fetchWorkHours(
  branchId: string | null,
  signal: AbortSignal,
): Promise<WorkHoursWindow> {
  const query = branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';
  const r = await apiFetch<unknown>(`/settings/work-hours${query}`, { signal });
  return isHours(r)
    ? { startHour: r.workStartHour, endHour: r.workEndHour }
    : DEFAULT_WORK_HOURS_WINDOW;
}

/**
 * Робочі години філії для пікера планових дат наряду й автокінця (BR-WO-019) і сітки календаря —
 * той самий `GET /settings/work-hours`, що й сервер, який перевіряє дати й ділить запис на дні.
 * `branchId` порожній: `mainBranch` — години основної філії (сітка календаря), інакше — типові
 * 09–18 без запиту (картка наряду, доки філію не обрано). Доки не завантажено чи при збої —
 * типові 09–18, як на сервері. Години змінюються рідко (сервер тримає їх у кеші 60 с) — одне
 * читання на хвилину на філію, а не на кожне відкриття картки.
 */
export function useBranchWorkHours(
  branchId: string | null | undefined,
  { mainBranch = false, enabled = true }: { mainBranch?: boolean; enabled?: boolean } = {},
): WorkHoursWindow {
  const key = branchId || null;
  const { data } = useQuery({
    queryKey: workHoursKeys.branch(key),
    queryFn: ({ signal }) => fetchWorkHours(key, signal),
    // `enabled: false` — роль без доступу до сторінки, що показує години (дашборд, Bug #879).
    enabled: enabled && (key !== null || mainBranch),
    staleTime: 60_000,
  });
  return data ?? DEFAULT_WORK_HOURS_WINDOW;
}
