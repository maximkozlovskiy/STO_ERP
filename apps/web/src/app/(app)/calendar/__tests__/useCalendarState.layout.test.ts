// Режим виду «День» (BR-CAL-014): адреса `?layout=` має пріоритет, далі — останній вибір у
// браузері (`localStorage`), інакше — планувальник. Вибір пишеться в адресу й у браузер;
// планувальник прибирає параметр з адреси. Недоступне сховище не ламає календар.
//
// Mutation-verify: прибрати читання `localStorage` → падає «останній вибір»; поміняти пріоритет
// адреси й сховища → падає «адреса важливіша»; не прибирати `layout` для планувальника → падає
// «планувальник прибирає параметр».

import { act, renderHook } from '@testing-library/react';
import { createQueryWrapper } from '@/__tests__/query-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
let params = new URLSearchParams('view=day&date=2026-10-15');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => params,
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: (url: string) =>
    Promise.resolve(url.startsWith('/calendar') || url.startsWith('/lifts') ? [] : { items: [] }),
}));

import { DAY_LAYOUT_KEY, useCalendarState } from '../useCalendarState';

const render = () => renderHook(() => useCalendarState(), { wrapper: createQueryWrapper() });
const lastUrl = () =>
  new URLSearchParams(String(replace.mock.calls.at(-1)?.[0] ?? '').replace(/^\?/, ''));

beforeEach(() => {
  replace.mockClear();
  params = new URLSearchParams('view=day&date=2026-10-15');
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useCalendarState — режим виду «День» (BR-CAL-014)', () => {
  // guards: BR-CAL-014
  it('типовий режим — планувальник', () => {
    expect(render().result.current.dayLayout).toBe('lifts');
  });

  // guards: BR-CAL-014
  it('останній вибір у браузері, коли адреса режиму не задає', () => {
    localStorage.setItem(DAY_LAYOUT_KEY, 'list');
    expect(render().result.current.dayLayout).toBe('list');
  });

  // guards: BR-CAL-014
  it('адреса важливіша за браузер; невідоме значення адреси ігнорується', () => {
    localStorage.setItem(DAY_LAYOUT_KEY, 'list');
    params = new URLSearchParams('view=day&date=2026-10-15&layout=hours');
    expect(render().result.current.dayLayout).toBe('hours');
    params = new URLSearchParams('view=day&date=2026-10-15&layout=bogus');
    expect(render().result.current.dayLayout).toBe('list');
  });

  // guards: BR-CAL-014
  it('вибір пишеться в адресу й у браузер; дата й вид лишаються', () => {
    const { result } = render();
    act(() => result.current.setDayLayout('list'));
    expect(lastUrl().get('layout')).toBe('list');
    expect(lastUrl().get('date')).toBe('2026-10-15');
    expect(lastUrl().get('view')).toBe('day');
    expect(localStorage.getItem(DAY_LAYOUT_KEY)).toBe('list');
  });

  // guards: BR-CAL-014
  it('планувальник прибирає параметр з адреси', () => {
    params = new URLSearchParams('view=day&date=2026-10-15&layout=list');
    const { result } = render();
    act(() => result.current.setDayLayout('lifts'));
    expect(lastUrl().has('layout')).toBe(false);
    expect(localStorage.getItem(DAY_LAYOUT_KEY)).toBe('lifts');
  });

  it('заблоковане сховище: режим — з адреси, без помилки', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const { result } = render();
    expect(result.current.dayLayout).toBe('lifts');
    act(() => result.current.setDayLayout('list'));
    expect(lastUrl().get('layout')).toBe('list');
  });
});
