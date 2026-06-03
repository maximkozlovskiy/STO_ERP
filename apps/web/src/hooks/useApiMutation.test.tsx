import { act, renderHook, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const featuresMock = { toastEnabled: true };
vi.mock('./useUiFeatures', () => ({
  useUiFeatures: () => featuresMock,
}));

import { useApiMutation } from './useApiMutation';
import { toast } from '@/lib/toast';

describe('useApiMutation', () => {
  beforeEach(() => {
    (toast.success as ReturnType<typeof vi.fn>).mockReset();
    (toast.error as ReturnType<typeof vi.fn>).mockReset();
    featuresMock.toastEnabled = true;
  });

  it('успіх → onSuccess викликаний з результатом + toast.success', async () => {
    const onSuccess = vi.fn();
    const fn = vi.fn().mockResolvedValue({ id: '1', name: 'X' });

    const { result } = renderHook(() => useApiMutation(fn, { onSuccess, successMsg: 'Збережено' }));

    let returned: unknown;
    await act(async () => {
      returned = await result.current.mutate({ name: 'X' });
    });

    expect(fn).toHaveBeenCalledWith({ name: 'X' });
    expect(onSuccess).toHaveBeenCalledWith({ id: '1', name: 'X' });
    expect(toast.success).toHaveBeenCalledWith('Збережено');
    expect(returned).toEqual({ id: '1', name: 'X' });
    expect(result.current.saving).toBe(false);
    expect(result.current.error).toBe('');
  });

  it('помилка → onError викликаний + error виставлений + toast.error', async () => {
    const onError = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error('Помилка мережі'));

    const { result } = renderHook(() => useApiMutation(fn, { onError }));

    let returned: unknown;
    await act(async () => {
      returned = await result.current.mutate(undefined as never);
    });

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Помилка мережі' }));
    expect(toast.error).toHaveBeenCalledWith('Помилка мережі');
    expect(returned).toBeUndefined();
    expect(result.current.error).toBe('Помилка мережі');
    expect(result.current.saving).toBe(false);
  });

  it('saving=true протягом виконання, false після завершення', async () => {
    let resolveFn!: (v: unknown) => void;
    const fn = vi.fn().mockImplementation(
      () =>
        new Promise(r => {
          resolveFn = r;
        }),
    );

    const { result } = renderHook(() => useApiMutation(fn));

    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.mutate(undefined as never);
    });
    await waitFor(() => expect(result.current.saving).toBe(true));

    await act(async () => {
      resolveFn({ ok: true });
      await promise;
    });

    expect(result.current.saving).toBe(false);
  });

  it('toastEnabled=false → toast.success НЕ викликаний', async () => {
    featuresMock.toastEnabled = false;
    const fn = vi.fn().mockResolvedValue({});

    const { result } = renderHook(() => useApiMutation(fn, { successMsg: 'OK' }));
    await act(async () => {
      await result.current.mutate(undefined as never);
    });

    expect(toast.success).not.toHaveBeenCalled();
  });

  it('latest onSuccess — стейл closure не виконується (Bug #330)', async () => {
    // Bug #330 regression guard: попередня версія тримала `options` у `useCallback` deps
    // з `eslint-disable react-hooks/exhaustive-deps` → onSuccess міг застаріти між
    // ререндерами і використовувати старі handler-и.
    const fn = vi.fn().mockResolvedValue('result');
    const onSuccessV1 = vi.fn();
    const onSuccessV2 = vi.fn();

    const { result, rerender } = renderHook(
      ({ onSuccess }: { onSuccess: () => void }) => useApiMutation(fn, { onSuccess }),
      { initialProps: { onSuccess: onSuccessV1 } },
    );

    // Реренджер з новим onSuccess
    rerender({ onSuccess: onSuccessV2 });

    await act(async () => {
      await result.current.mutate(undefined as never);
    });

    expect(onSuccessV2).toHaveBeenCalledWith('result');
    expect(onSuccessV1).not.toHaveBeenCalled();
  });

  it('clearError очищує помилку', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Помилка'));
    const { result } = renderHook(() => useApiMutation(fn));

    await act(async () => {
      await result.current.mutate(undefined as never);
    });
    expect(result.current.error).toBe('Помилка');

    act(() => {
      result.current.clearError();
    });
    expect(result.current.error).toBe('');
  });

  it('errorMsg використовується як fallback коли помилка не Error instance', async () => {
    const fn = vi.fn().mockRejectedValue('string error');
    const { result } = renderHook(() => useApiMutation(fn, { errorMsg: 'Резервна' }));

    await act(async () => {
      await result.current.mutate(undefined as never);
    });

    expect(result.current.error).toBe('Резервна');
  });
});
