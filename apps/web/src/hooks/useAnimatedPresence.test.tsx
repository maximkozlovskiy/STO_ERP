import { act, renderHook } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';
import { useAnimatedPresence } from './useAnimatedPresence';

/**
 * Test contract for useAnimatedPresence — keeps DOM alive during exit animation.
 *
 * Enter:   open=true  → visible=true immediately; state flips to "open" after rAF.
 * Exit:    open=false → state flips to "closed" immediately; visible flips
 *                       to false after exitDuration (default 180ms).
 * Toggle:  rapid open=true→false→true must NOT leak setTimeout / rAF
 *          (cleanup of previous effect cancels the pending callback).
 *
 * jsdom does not implement requestAnimationFrame consistently across versions —
 * we stub it with a controllable queue so tests can fire rAF on demand.
 */
describe('useAnimatedPresence', () => {
  // Controllable rAF queue. Calling flushRaf() invokes ALL pending callbacks.
  let rafQueue: Array<FrameRequestCallback>;
  let rafId = 0;
  let cancelledIds: Set<number>;

  function flushRaf(): void {
    const callbacks = rafQueue;
    rafQueue = [];
    callbacks.forEach((cb, idx) => {
      // rAF id is offset by current rafId minus remaining length
      const id = rafId - callbacks.length + idx + 1;
      if (!cancelledIds.has(id)) cb(performance.now());
    });
  }

  beforeEach(() => {
    rafQueue = [];
    cancelledIds = new Set();
    rafId = 0;
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (cb: FrameRequestCallback): number => {
        rafQueue.push(cb);
        rafId += 1;
        return rafId;
      },
    );
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number): void => {
      cancelledIds.add(id);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── Enter ──────────────────────────────────────────────────────────────

  it('open=true з самого початку: visible=true, state="open" одразу (no rAF потрібен для init)', () => {
    const { result } = renderHook(() => useAnimatedPresence(true));
    // Initial render values from useState(open) and useState(open ? 'open' : 'closed')
    expect(result.current.visible).toBe(true);
    expect(result.current.state).toBe('open');
  });

  it('open=false з самого початку: visible=false, state="closed"', () => {
    const { result } = renderHook(() => useAnimatedPresence(false));
    expect(result.current.visible).toBe(false);
    expect(result.current.state).toBe('closed');
  });

  it('enter: open=false → true → visible=true одразу; state стає "open" після rAF', () => {
    const { result, rerender } = renderHook(({ open }) => useAnimatedPresence(open), {
      initialProps: { open: false },
    });
    expect(result.current.visible).toBe(false);
    expect(result.current.state).toBe('closed');

    act(() => {
      rerender({ open: true });
    });
    // visible перевертається в true синхронно під час effect
    expect(result.current.visible).toBe(true);
    // state ще НЕ "open" — чекаємо на rAF
    expect(result.current.state).toBe('closed');

    // Запускаємо rAF callback → state стає "open"
    act(() => {
      flushRaf();
    });
    expect(result.current.state).toBe('open');
  });

  // ─── Exit ──────────────────────────────────────────────────────────────

  it('exit: open=true → false → state="closed" одразу; visible=false ПІСЛЯ exitDuration', () => {
    const { result, rerender } = renderHook(({ open }) => useAnimatedPresence(open), {
      initialProps: { open: true },
    });
    expect(result.current.visible).toBe(true);
    expect(result.current.state).toBe('open');

    act(() => {
      rerender({ open: false });
    });
    // state одразу "closed", але visible ще true (DOM лишається для exit-анімації)
    expect(result.current.state).toBe('closed');
    expect(result.current.visible).toBe(true);

    // Прокручуємо 179ms — visible все ще true (timeout 180ms не дoswрав)
    act(() => {
      vi.advanceTimersByTime(179);
    });
    expect(result.current.visible).toBe(true);

    // Прокручуємо ще 1ms → timeout зрабатывает → visible=false
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.visible).toBe(false);
    expect(result.current.state).toBe('closed');
  });

  it('exit з кастомним exitDuration=300ms: visible=false після 300ms, не раніше', () => {
    const { result, rerender } = renderHook(({ open }) => useAnimatedPresence(open, 300), {
      initialProps: { open: true },
    });
    act(() => {
      rerender({ open: false });
    });
    expect(result.current.visible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(180); // default exit time
    });
    // У дефолтному ХУКу visible вже би скинувся, але тут exitDuration=300
    expect(result.current.visible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(120); // tot 300
    });
    expect(result.current.visible).toBe(false);
  });

  // ─── Rapid toggle ───────────────────────────────────────────────────────

  it('rapid toggle open=true → false → true: попередній setTimeout cancelled, visible лишається true', () => {
    const clearSpy = vi.spyOn(window, 'clearTimeout');

    const { result, rerender } = renderHook(({ open }) => useAnimatedPresence(open), {
      initialProps: { open: true },
    });

    // Закриваємо
    act(() => {
      rerender({ open: false });
    });
    expect(result.current.state).toBe('closed');
    expect(result.current.visible).toBe(true);

    // Відкриваємо знову ДО exitDuration
    act(() => {
      rerender({ open: true });
    });

    // Cleanup попереднього effect повинен був cancelClear timeout
    expect(clearSpy).toHaveBeenCalled();

    // visible лишається true (вже був true — setVisible(true) idempotent)
    expect(result.current.visible).toBe(true);

    // Прокручуємо повний exitDuration — visible НЕ має стати false (timeout cancelled)
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.visible).toBe(true);

    // rAF flush → state="open"
    act(() => {
      flushRaf();
    });
    expect(result.current.state).toBe('open');
  });

  it('rapid toggle open=false → true → false: попередній rAF cancelled, state не застряг на "open"', () => {
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame');

    const { result, rerender } = renderHook(({ open }) => useAnimatedPresence(open), {
      initialProps: { open: false },
    });
    expect(result.current.state).toBe('closed');
    expect(result.current.visible).toBe(false);

    // Відкриваємо
    act(() => {
      rerender({ open: true });
    });
    expect(result.current.visible).toBe(true);
    expect(result.current.state).toBe('closed'); // rAF ще не виконався

    // Закриваємо ПЕРЕД rAF
    act(() => {
      rerender({ open: false });
    });

    // Cleanup попереднього rAF
    expect(cancelSpy).toHaveBeenCalled();

    // state — "closed" (від exit-гілки)
    expect(result.current.state).toBe('closed');

    // Якщо ми тепер запустимо rAF — попередній колбек скасований, state не має змінитися
    act(() => {
      flushRaf();
    });
    expect(result.current.state).toBe('closed');

    // exitDuration → visible=false
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.visible).toBe(false);
  });

  it('rapid toggle: тільки ОДИН активний setTimeout у будь-який момент', () => {
    const { rerender } = renderHook(({ open }) => useAnimatedPresence(open), {
      initialProps: { open: true },
    });

    // Серія швидких перемикань
    act(() => {
      rerender({ open: false });
    });
    act(() => {
      rerender({ open: true });
    });
    act(() => {
      rerender({ open: false });
    });
    act(() => {
      rerender({ open: true });
    });

    // У будь-який момент має існувати щонайбільше 1 активний таймер (попередні cancelled).
    // Прокручуємо 200ms — якщо було б >1 таймер, ми б побачили race; перевіряємо state.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    // Останнє open=true → візьмемось до rAF
    act(() => {
      flushRaf();
    });
    // Кінцевий стан: visible=true, state="open"
    // Якщо stale timeout від попередніх "closed" фаз пройшов, visible був би false
    // (бо setVisible(false) з якогось залишеного таймера) — баг ловиться тут.
    const { result } = renderHook(({ open }) => useAnimatedPresence(open), {
      initialProps: { open: true },
    });
    expect(result.current.visible).toBe(true);
    expect(result.current.state).toBe('open');
  });

  // ─── Cleanup on unmount ─────────────────────────────────────────────────

  it('unmount під час exit-анімації не лишає dangling setTimeout', () => {
    const clearSpy = vi.spyOn(window, 'clearTimeout');

    const { rerender, unmount } = renderHook(({ open }) => useAnimatedPresence(open), {
      initialProps: { open: true },
    });

    act(() => {
      rerender({ open: false });
    });

    // Розмонтовуємо ДО завершення exit-таймера
    act(() => {
      unmount();
    });

    // Cleanup має очистити pending timeout
    expect(clearSpy).toHaveBeenCalled();
  });

  it('unmount між rerender та rAF не лишає dangling rAF', () => {
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame');

    const { rerender, unmount } = renderHook(({ open }) => useAnimatedPresence(open), {
      initialProps: { open: false },
    });

    act(() => {
      rerender({ open: true });
    });

    act(() => {
      unmount();
    });

    expect(cancelSpy).toHaveBeenCalled();
  });
});
