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
  /** Робочі дні ISO (1 = пн … 7 = нд); старий сервер поля не віддає. */
  workDays?: unknown;
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

/**
 * Робочі дні з відповіді: цілі 1..7 без повторів. Поля немає, воно не масив чи в ньому жодного
 * валідного дня — `undefined`, тобто кожен день робочий (як сервер для філії без переліку).
 */
function parseWorkDays(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const days = [
    ...new Set(raw.filter((d): d is number => Number.isInteger(d) && d >= 1 && d <= 7)),
  ].sort((a, b) => a - b);
  return days.length > 0 ? days : undefined;
}

async function fetchWorkHours(
  branchId: string | null,
  signal: AbortSignal,
): Promise<WorkHoursWindow> {
  const query = branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';
  const r = await apiFetch<unknown>(`/settings/work-hours${query}`, { signal });
  if (!isHours(r)) return DEFAULT_WORK_HOURS_WINDOW;
  const workDays = parseWorkDays(r.workDays);
  return workDays
    ? { startHour: r.workStartHour, endHour: r.workEndHour, workDays }
    : { startHour: r.workStartHour, endHour: r.workEndHour };
}

/**
 * Робочі години й робочі дні філії для пікера планових дат наряду й автокінця (BR-WO-019) і сітки
 * календаря — той самий `GET /settings/work-hours`, що й сервер, який перевіряє дати й ділить
 * запис на дні (вихідні — BR-CAL-016).
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
