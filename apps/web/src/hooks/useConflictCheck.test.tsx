import { act, renderHook } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { useConflictCheck } from './useConflictCheck';

describe('useConflictCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiFetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounce: один виклик check() через 400ms відправляє один fetch', async () => {
    apiFetchMock.mockResolvedValue({
      liftConflict: false,
      employeeConflict: false,
      anyConflict: false,
      conflictSlots: [],
    });
    const { result } = renderHook(() => useConflictCheck(400));

    act(() => {
      result.current.check({
        liftId: 'L1',
        startAt: '2026-05-22T10:00:00.000Z',
        endAt: '2026-05-22T11:00:00.000Z',
      });
    });

    expect(apiFetchMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('debounce: швидкі множинні check() запускають лише останній fetch', async () => {
    apiFetchMock.mockResolvedValue({
      liftConflict: false,
      employeeConflict: false,
      anyConflict: false,
      conflictSlots: [],
    });
    const { result } = renderHook(() => useConflictCheck(400));

    act(() => {
      result.current.check({
        liftId: 'L1',
        startAt: '2026-05-22T10:00:00.000Z',
        endAt: '2026-05-22T11:00:00.000Z',
      });
    });
    act(() => {
      result.current.check({
        liftId: 'L2',
        startAt: '2026-05-22T10:00:00.000Z',
        endAt: '2026-05-22T11:00:00.000Z',
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/calendar/slots/check-conflicts',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"liftId":"L2"'),
      }),
    );
  });

  it('endAt <= startAt → setConflict(null) без fetch', async () => {
    const { result } = renderHook(() => useConflictCheck(400));

    act(() => {
      result.current.check({
        liftId: 'L1',
        startAt: '2026-05-22T11:00:00.000Z',
        endAt: '2026-05-22T10:00:00.000Z',
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(result.current.conflict).toBeNull();
  });

  it('Bug #396: early-return invalidate in-flight fetch — стара відповідь не перезаписує очищений стан', async () => {
    // Setup: in-flight fetch was deferred; before it resolves, params become invalid.
    let resolveFn!: (v: unknown) => void;
    apiFetchMock.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveFn = resolve;
        }),
    );
    const { result } = renderHook(() => useConflictCheck(400));

    act(() => {
      result.current.check({
        liftId: 'L1',
        startAt: '2026-05-22T10:00:00.000Z',
        endAt: '2026-05-22T11:00:00.000Z',
      });
    });
    // Запускаємо fetch (через дебаунс)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    // Поки fetch in-flight — користувач робить параметри невалідними (порожні дати)
    act(() => {
      result.current.check({
        liftId: 'L1',
        startAt: '',
        endAt: '',
      });
    });
    expect(result.current.conflict).toBeNull();

    // Тепер старий in-flight resolve приходить з реальним конфліктом
    await act(async () => {
      resolveFn({
        liftConflict: true,
        employeeConflict: false,
        anyConflict: true,
        conflictSlots: [{ id: 's1' }],
      });
      // дочекатись microtask
      await Promise.resolve();
    });
    // Очікуємо що стара відповідь ПРОІГНОРОВАНА — стан залишився null
    expect(result.current.conflict).toBeNull();
  });

  it('clear() інвалідовує in-flight fetch (без race)', async () => {
    let resolveFn!: (v: unknown) => void;
    apiFetchMock.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveFn = resolve;
        }),
    );
    const { result } = renderHook(() => useConflictCheck(400));

    act(() => {
      result.current.check({
        liftId: 'L1',
        startAt: '2026-05-22T10:00:00.000Z',
        endAt: '2026-05-22T11:00:00.000Z',
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.clear();
    });
    expect(result.current.conflict).toBeNull();

    await act(async () => {
      resolveFn({
        liftConflict: true,
        employeeConflict: false,
        anyConflict: true,
        conflictSlots: [{ id: 's1' }],
      });
      await Promise.resolve();
    });
    expect(result.current.conflict).toBeNull();
  });

  it('unmount: pending fetch не викликає setConflict (no memory leak)', async () => {
    // Bug #438 (SKILL §1.6 Bug #287): попередня версія мала `expect(true).toBe(true)`
    // → завжди зелений. Видалення guard `if (!mountedRef.current) return` у hook не
    // ловиться тестом. Реальна перевірка через console-spy:
    // React емітить warning «Can't perform a React state update on an unmounted component»
    // тільки якщо setState виконано після unmount → spy ловить регресію.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let resolveFn!: (v: unknown) => void;
    apiFetchMock.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveFn = resolve;
        }),
    );
    const { result, unmount } = renderHook(() => useConflictCheck(400));

    act(() => {
      result.current.check({
        liftId: 'L1',
        startAt: '2026-05-22T10:00:00.000Z',
        endAt: '2026-05-22T11:00:00.000Z',
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    unmount();

    // Резолв після анмаунту — guard має блокувати setConflict
    await act(async () => {
      resolveFn({
        liftConflict: true,
        employeeConflict: false,
        anyConflict: true,
        conflictSlots: [],
      });
      await Promise.resolve();
    });

    // Bug #438: replace fake-green з реальною асертацією — будь-яка регресія
    // mountedRef guard викличе React warning у console.error.
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/state update.*unmounted component/i),
    );

    // Stale apiFetch count — гарантоване (нічого нового не додалось)
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    // result.current.conflict ХОДА недоступне після unmount, тому не асертимо.
    consoleErrorSpy.mockRestore();
  });

  // Bug #437: conflictWoNumbers витягнуто у hook у refactor 4a70b0f9 з consumer-компонентів.
  // Без тестів — майбутній refactor (видалити guard `if (s.workOrderNumber)`, змінити
  // join separator) пройде CI зеленим, але користувач побачить зламаний banner.
  describe('conflictWoNumbers (derived) — Bug #437', () => {
    it('повертає порожній рядок коли conflict=null (initial state)', () => {
      const { result } = renderHook(() => useConflictCheck(400));
      expect(result.current.conflictWoNumbers).toBe('');
    });

    it('повертає порожній рядок коли conflictSlots=[]', async () => {
      apiFetchMock.mockResolvedValue({
        liftConflict: false,
        employeeConflict: false,
        anyConflict: false,
        conflictSlots: [],
      });
      const { result } = renderHook(() => useConflictCheck(400));
      act(() => {
        result.current.check({
          liftId: 'L1',
          startAt: '2026-05-22T10:00:00.000Z',
          endAt: '2026-05-22T11:00:00.000Z',
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(result.current.conflictWoNumbers).toBe('');
    });

    it('joins workOrderNumber з кожного slot через ", " (з пробілом)', async () => {
      apiFetchMock.mockResolvedValue({
        liftConflict: true,
        employeeConflict: false,
        anyConflict: true,
        conflictSlots: [
          { id: 's1', workOrderNumber: 'WO-001', startAt: '', endAt: '', status: 'X', type: 'Y' },
          { id: 's2', workOrderNumber: 'WO-002', startAt: '', endAt: '', status: 'X', type: 'Y' },
        ],
      });
      const { result } = renderHook(() => useConflictCheck(400));
      act(() => {
        result.current.check({
          liftId: 'L1',
          startAt: '2026-05-22T10:00:00.000Z',
          endAt: '2026-05-22T11:00:00.000Z',
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(result.current.conflictWoNumbers).toBe('WO-001, WO-002');
    });

    it('пропускає slots без workOrderNumber — повертає тільки наявні номери', async () => {
      apiFetchMock.mockResolvedValue({
        liftConflict: true,
        employeeConflict: false,
        anyConflict: true,
        conflictSlots: [
          { id: 's1', workOrderNumber: 'WO-001', startAt: '', endAt: '', status: 'X', type: 'Y' },
          { id: 's2', startAt: '', endAt: '', status: 'X', type: 'Y' }, // no workOrderNumber
          { id: 's3', workOrderNumber: 'WO-003', startAt: '', endAt: '', status: 'X', type: 'Y' },
        ],
      });
      const { result } = renderHook(() => useConflictCheck(400));
      act(() => {
        result.current.check({
          liftId: 'L1',
          startAt: '2026-05-22T10:00:00.000Z',
          endAt: '2026-05-22T11:00:00.000Z',
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      // НЕ містить undefined/null/порожнечі — тільки явно задані номери
      expect(result.current.conflictWoNumbers).toBe('WO-001, WO-003');
    });
  });

  it('excludeWorkOrderId передається у body запиту (Bug #397)', async () => {
    apiFetchMock.mockResolvedValue({
      liftConflict: false,
      employeeConflict: false,
      anyConflict: false,
      conflictSlots: [],
    });
    const { result } = renderHook(() => useConflictCheck(400));

    act(() => {
      result.current.check({
        liftId: 'L1',
        startAt: '2026-05-22T10:00:00.000Z',
        endAt: '2026-05-22T11:00:00.000Z',
        excludeWorkOrderId: 'WO-1',
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/calendar/slots/check-conflicts',
      expect.objectContaining({
        body: expect.stringContaining('"excludeWorkOrderId":"WO-1"'),
      }),
    );
  });
});
