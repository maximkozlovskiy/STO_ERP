import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDirtyForm } from './useDirtyForm';

const beforeUnloadBlocked = () => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

describe('useDirtyForm — «Покинути» відкидає зміни (Bug #928)', () => {
  it('змінена форма охороняє перехід', () => {
    const { result } = renderHook(() => useDirtyForm());
    act(() => result.current.markDirty());
    expect(beforeUnloadBlocked()).toBe(true);
  });

  it('після «Покинути» — не охороняє й не питає вдруге', async () => {
    const { result } = renderHook(() => useDirtyForm());
    act(() => result.current.markDirty());

    let closing: Promise<boolean> = Promise.resolve(false);
    act(() => {
      closing = result.current.confirmClose();
    });
    expect(result.current.dialogProps.open).toBe(true);
    act(() => result.current.dialogProps.onConfirm());
    await expect(closing).resolves.toBe(true);

    expect(result.current.isDirty).toBe(false);
    expect(beforeUnloadBlocked()).toBe(false);
    await expect(result.current.confirmClose()).resolves.toBe(true);
  });

  it('«Скасувати» лишає зміни під охороною', async () => {
    const { result } = renderHook(() => useDirtyForm());
    act(() => result.current.markDirty());

    let closing: Promise<boolean> = Promise.resolve(true);
    act(() => {
      closing = result.current.confirmClose();
    });
    act(() => result.current.dialogProps.onCancel());
    await expect(closing).resolves.toBe(false);

    expect(beforeUnloadBlocked()).toBe(true);
  });
});
