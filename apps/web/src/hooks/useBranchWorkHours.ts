'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { DEFAULT_WORK_DAYS } from '@sto/shared';
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
 * валідного дня — пн–пт (`DEFAULT_WORK_DAYS`), як сервер (BR-CAL-016).
 */
function parseWorkDays(raw: unknown): readonly number[] {
  if (!Array.isArray(raw)) return DEFAULT_WORK_DAYS;
  const days = [
    ...new Set(raw.filter((d): d is number => Number.isInteger(d) && d >= 1 && d <= 7)),
  ].sort((a, b) => a - b);
  return days.length > 0 ? days : DEFAULT_WORK_DAYS;
}

async function fetchWorkHours(
  branchId: string | null,
  signal: AbortSignal,
): Promise<WorkHoursWindow> {
  const query = branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';
  const r = await apiFetch<unknown>(`/settings/work-hours${query}`, { signal });
  if (!isHours(r)) return DEFAULT_WORK_HOURS_WINDOW;
  return {
    startHour: r.workStartHour,
    endHour: r.workEndHour,
    workDays: parseWorkDays(r.workDays),
  };
}

/**
 * Робочі години й дні філії, як їх віддав сервер; `null` — ще не завантажено, запит вимкнено чи він
 * упав. Для місць, де до відповіді краще взяти ІНШІ години, а не типові: форма запису календаря
 * рахує за годинами основної філії, доки не прочитано години філії підйомника (BR-CAL-017).
 */
export function useBranchWorkHoursQuery(
  branchId: string | null | undefined,
  { mainBranch = false, enabled = true }: { mainBranch?: boolean; enabled?: boolean } = {},
): WorkHoursWindow | null {
  const key = branchId || null;
  const { data } = useQuery({
    queryKey: workHoursKeys.branch(key),
    queryFn: ({ signal }) => fetchWorkHours(key, signal),
    // `enabled: false` — роль без доступу до сторінки, що показує години (дашборд, Bug #879).
    enabled: enabled && (key !== null || mainBranch),
    staleTime: 60_000,
  });
  return data ?? null;
}

/**
 * Робочі години й робочі дні філії для пікера планових дат наряду й автокінця (BR-WO-019) і сітки
 * календаря — той самий `GET /settings/work-hours`, що й сервер, який перевіряє дати й ділить
 * запис на дні (вихідні — BR-CAL-016).
 * `branchId` порожній: `mainBranch` — години основної філії (сітка календаря), інакше — типові
 * 09–18, пн–пт без запиту (картка наряду, доки філію не обрано). Доки не завантажено чи при збої —
 * типові 09–18, пн–пт, як на сервері. Години змінюються рідко (сервер тримає їх у кеші 60 с) —
 * одне читання на хвилину на філію, а не на кожне відкриття картки.
 */
export function useBranchWorkHours(
  branchId: string | null | undefined,
  opts: { mainBranch?: boolean; enabled?: boolean } = {},
): WorkHoursWindow {
  return useBranchWorkHoursQuery(branchId, opts) ?? DEFAULT_WORK_HOURS_WINDOW;
}
