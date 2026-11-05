// Робочі дні філії з `GET /settings/work-hours` (рішення власника 2026-10-30, BR-WO-019): пікер
// планових дат і автокінець пропускають вихідні. Поля немає (стара збірка api), воно зіпсоване чи
// порожнє — кожен день робочий, як на сервері для філії без переліку днів.
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetchMock(...a) }));

import { useBranchWorkHours } from '../useBranchWorkHours';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function hoursFor(response: unknown) {
  apiFetchMock.mockResolvedValue(response);
  const { result } = renderHook(() => useBranchWorkHours('branch-1'), { wrapper });
  await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
  await waitFor(() => expect(result.current.startHour).toBe(8));
  return result.current;
}

describe('useBranchWorkHours — робочі дні філії', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  // guards: BR-WO-019
  it('workDays з відповіді — відсортовані цілі 1..7 без повторів', async () => {
    const wh = await hoursFor({
      workStartHour: 8,
      workEndHour: 17,
      workDays: [6, 1, 2, 2, 3, 4, 5],
    });
    expect(wh).toEqual({ startHour: 8, endHour: 17, workDays: [1, 2, 3, 4, 5, 6] });
    expect(apiFetchMock.mock.calls[0]![0]).toBe('/settings/work-hours?branchId=branch-1');
  });

  // guards: BR-WO-019
  it.each([
    ['поля немає (стара збірка api)', undefined],
    ['не масив', 'пн-сб'],
    ['жодного валідного дня', [0, 8, 1.5]],
    ['порожній перелік', []],
  ])('%s → без переліку днів, тобто кожен день робочий', async (_l, workDays) => {
    const wh = await hoursFor({ workStartHour: 8, workEndHour: 17, workDays });
    expect(wh).toEqual({ startHour: 8, endHour: 17 });
  });
});
