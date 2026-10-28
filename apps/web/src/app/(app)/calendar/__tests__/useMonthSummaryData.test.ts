// Підсумки місяця на дашборді (BR-CAL-013): записи місяця — одним запитом діапазону з першим
// числом наступного (кінець ланцюжка), але в підсумок входять лише дні місяця; після змін
// календаря (`notifyCalendarChanged`) записи перечитуються; без доступу — жодного запиту.

import { act, renderHook, waitFor } from '@testing-library/react';
import { createQueryWrapper } from '@/__tests__/query-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarSlot } from '../calendar.types';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (url: string, init?: unknown) => apiFetch(url, init),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }) }));

import { notifyCalendarChanged } from '@/lib/calendar-events';
import { useMonthSummaryData } from '../useMonthSummaryData';

const slot = (id: string, start: string, end: string): CalendarSlot => ({
  id,
  liftId: 'lift-1',
  startAt: new Date(start).toISOString(),
  endAt: new Date(end).toISOString(),
});

let slots: CalendarSlot[] = [];
const slotCalls = () =>
  apiFetch.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/calendar/slots'));

beforeEach(() => {
  apiFetch.mockReset();
  slots = [];
  apiFetch.mockImplementation((url: string) => {
    if (url.startsWith('/calendar/slots')) return Promise.resolve(slots);
    if (url.startsWith('/lifts')) return Promise.resolve([{ id: 'lift-1', name: 'Пост 1' }]);
    if (url.startsWith('/tasks')) return Promise.resolve({ items: [], total: 0 });
    return Promise.resolve({});
  });
});

describe('useMonthSummaryData (BR-CAL-013)', () => {
  // guards: BR-CAL-013
  it('один запит діапазону з 1-м числом наступного; у підсумку — лише дні місяця', async () => {
    slots = [
      slot('oct', '2026-10-20T09:00:00+03:00', '2026-10-20T10:00:00+03:00'),
      slot('nov', '2026-11-01T09:00:00+02:00', '2026-11-01T10:00:00+02:00'),
    ];
    const { result } = renderHook(() => useMonthSummaryData('2026-10', true), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(slotCalls()).toEqual(['/calendar/slots?from=2026-10-01&to=2026-11-01']);
    expect(result.current.monthSlots['2026-10-20'].total).toBe(1);
    expect(result.current.monthSlots['2026-11-01']).toBeUndefined();
    await waitFor(() => expect(result.current.lifts).toHaveLength(1));
  });

  // guards: BR-CAL-013
  it('зміна в календарі → записи перечитуються', async () => {
    const { result } = renderHook(() => useMonthSummaryData('2026-10', true), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    slots = [slot('new', '2026-10-21T09:00:00+03:00', '2026-10-21T10:00:00+03:00')];
    act(() => notifyCalendarChanged());
    await waitFor(() => expect(result.current.monthSlots['2026-10-21']?.total).toBe(1));
    expect(slotCalls()).toHaveLength(2);
  });

  it('без доступу — ні записів, ні підйомників, ні задач', async () => {
    renderHook(() => useMonthSummaryData('2026-10', false), { wrapper: createQueryWrapper() });
    await new Promise(r => setTimeout(r, 50));
    expect(
      apiFetch.mock.calls.map(c => String(c[0])).filter(u => !u.startsWith('/settings')),
    ).toEqual([]);
  });
});
