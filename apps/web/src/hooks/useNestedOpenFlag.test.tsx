import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNestedOpenFlag } from './useNestedOpenFlag';

describe('useNestedOpenFlag (Bug #931)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('true, поки вкладене вікно відкрите; знімається лише ПІСЛЯ поточної події', () => {
    const { result, rerender } = renderHook(({ open }) => useNestedOpenFlag(open), {
      initialProps: { open: false },
    });
    expect(result.current.current).toBe(false);

    rerender({ open: true });
    expect(result.current.current).toBe(true);

    rerender({ open: false });
    // Той самий Escape ще обходить слухачі картки — прапорець має стояти.
    expect(result.current.current).toBe(true);
    act(() => vi.runAllTimers());
    expect(result.current.current).toBe(false);
  });

  it('вікно відкрили знову до таймера — прапорець не знімається', () => {
    const { result, rerender } = renderHook(({ open }) => useNestedOpenFlag(open), {
      initialProps: { open: true },
    });
    rerender({ open: false });
    rerender({ open: true });
    act(() => vi.runAllTimers());
    expect(result.current.current).toBe(true);
  });
});
