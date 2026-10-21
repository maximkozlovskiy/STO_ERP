// usePendingOpen — вкладене вікно, що відкривається після запиту (Bug #935): поки запит у дорозі,
// Escape скасовує відкриття і не доходить до вікна-власника; закрите тим часом вікно-власник
// відкриття теж скасовує.

import { act, renderHook } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach, type Mock } from 'vitest';
import { usePendingOpen } from './usePendingOpen';
import { useEscapeLayer } from './useEscapeLayer';

let ownerEscape: Mock<() => void>;

beforeEach(() => {
  ownerEscape = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const pressEscape = () =>
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

/** Вікно-власник (шар Escape, як `<Modal open>`) і хук усередині нього. */
function renderOwner(ownerOpen = true) {
  return renderHook(
    ({ open }: { open: boolean }) => {
      useEscapeLayer(open, ownerEscape);
      return usePendingOpen(open);
    },
    { initialProps: { open: ownerOpen } },
  );
}

describe('usePendingOpen', () => {
  it('без втручання: після відповіді показує дані', async () => {
    const { result } = renderOwner();
    const show = vi.fn();
    await act(() => result.current(() => Promise.resolve('cp'), show));
    expect(show).toHaveBeenCalledWith('cp');
  });

  it('Escape під час запиту скасовує відкриття, вікно-власник Escape не отримує', async () => {
    const { result } = renderOwner();
    const show = vi.fn();
    const load = deferred<string>();
    let run!: Promise<void>;
    act(() => {
      run = result.current(() => load.promise, show);
    });

    pressEscape();
    expect(ownerEscape).not.toHaveBeenCalled();

    await act(async () => {
      load.resolve('cp');
      await run;
    });
    expect(show).not.toHaveBeenCalled();

    // Завантаження більше не шар: наступний Escape — вікну-власнику.
    pressEscape();
    expect(ownerEscape).toHaveBeenCalledTimes(1);
  });

  it('вікно-власник закрито під час запиту — картка не відкривається сиротою', async () => {
    const { result, rerender } = renderOwner();
    const show = vi.fn();
    const load = deferred<string>();
    let run!: Promise<void>;
    act(() => {
      run = result.current(() => load.promise, show);
    });

    rerender({ open: false });
    await act(async () => {
      load.resolve('cp');
      await run;
    });
    expect(show).not.toHaveBeenCalled();
  });

  it('помилка нескасованого запиту летить до виклику, скасованого — мовчить', async () => {
    const { result } = renderOwner();
    await expect(
      act(() => result.current(() => Promise.reject(new Error('збій')), vi.fn())),
    ).rejects.toThrow('збій');

    const load = deferred<string>();
    let run!: Promise<void>;
    act(() => {
      run = result.current(() => load.promise, vi.fn());
    });
    pressEscape();
    await act(async () => {
      load.reject(new Error('збій'));
      await run;
    });
  });

  it('повторне відкриття: показує лише останній запит', async () => {
    const { result } = renderOwner();
    const show = vi.fn();
    const first = deferred<string>();
    const second = deferred<string>();
    let run1!: Promise<void>;
    let run2!: Promise<void>;
    act(() => {
      run1 = result.current(() => first.promise, show);
    });
    act(() => {
      run2 = result.current(() => second.promise, show);
    });
    await act(async () => {
      second.resolve('другий');
      first.resolve('перший');
      await Promise.all([run1, run2]);
    });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith('другий');
  });
});
