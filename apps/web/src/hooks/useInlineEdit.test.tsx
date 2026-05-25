import { act, renderHook, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { useInlineEdit } from './useInlineEdit';

describe('useInlineEdit', () => {
  let onSave: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSave = vi.fn().mockResolvedValue(undefined);
  });

  it('початковий стан: editing=null, saving=false', () => {
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    expect(result.current.editing).toBeNull();
    expect(result.current.saving).toBe(false);
  });

  it('startEdit встановлює editing з rowId/field/value', () => {
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => { result.current.startEdit('r1', 'name', 'Joe'); });
    expect(result.current.editing).toEqual({ rowId: 'r1', field: 'name', value: 'Joe' });
  });

  it('startEdit не діє коли enabled=false', () => {
    const { result } = renderHook(() => useInlineEdit({ onSave, enabled: false }));
    act(() => { result.current.startEdit('r1', 'name', 'Joe'); });
    expect(result.current.editing).toBeNull();
  });

  it('isEditing повертає true тільки для відповідної комбінації', () => {
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => { result.current.startEdit('r1', 'name', 'Joe'); });
    expect(result.current.isEditing('r1', 'name')).toBe(true);
    expect(result.current.isEditing('r1', 'email')).toBe(false);
    expect(result.current.isEditing('r2', 'name')).toBe(false);
  });

  it('cancelEdit скидає editing на null', () => {
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => { result.current.startEdit('r1', 'name', 'Joe'); });
    act(() => { result.current.cancelEdit(); });
    expect(result.current.editing).toBeNull();
  });

  it('commitEdit з value === editing.value пропускає save (no-op)', async () => {
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => { result.current.startEdit('r1', 'name', 'Joe'); });
    await act(async () => { await result.current.commitEdit('Joe'); });
    expect(onSave).not.toHaveBeenCalled();
    expect(result.current.editing).toBeNull();
  });

  it('commitEdit викликає onSave з trimmed value і виходить з edit при успіху', async () => {
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => { result.current.startEdit('r1', 'name', 'Joe'); });
    await act(async () => { await result.current.commitEdit('  Jane  '); });
    expect(onSave).toHaveBeenCalledWith('r1', 'name', 'Jane');
    expect(result.current.editing).toBeNull();
  });

  it('commitEdit зберігає editing state при помилці і re-throws', async () => {
    const err = new Error('API 400');
    onSave.mockRejectedValueOnce(err);
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => { result.current.startEdit('r1', 'name', 'Joe'); });

    await act(async () => {
      await expect(result.current.commitEdit('Jane')).rejects.toThrow('API 400');
    });

    // Edit state preserved for retry
    expect(result.current.editing).toEqual({ rowId: 'r1', field: 'name', value: 'Joe' });
    expect(result.current.saving).toBe(false);
  });

  it('savingRef блокує double-commit (другий виклик ігнорується доки save in-flight)', async () => {
    let resolveSave: () => void = () => {};
    onSave.mockReturnValueOnce(new Promise<void>(resolve => { resolveSave = resolve; }));
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => { result.current.startEdit('r1', 'name', 'Joe'); });

    // Fire two concurrent commits without awaiting the first
    let firstPromise!: Promise<void>;
    act(() => { firstPromise = result.current.commitEdit('Jane'); });
    await act(async () => { await result.current.commitEdit('Maria'); });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('r1', 'name', 'Jane');

    // Resolve the in-flight save
    await act(async () => {
      resolveSave();
      await firstPromise;
    });
    await waitFor(() => expect(result.current.editing).toBeNull());
  });

  it('cancelEdit ігнорується доки saving in-flight (захист стану)', async () => {
    let resolveSave: () => void = () => {};
    onSave.mockReturnValueOnce(new Promise<void>(resolve => { resolveSave = resolve; }));
    const { result } = renderHook(() => useInlineEdit({ onSave }));
    act(() => { result.current.startEdit('r1', 'name', 'Joe'); });

    let commitPromise!: Promise<void>;
    act(() => { commitPromise = result.current.commitEdit('Jane'); });
    // saving=true, ref=true → cancel should be ignored
    act(() => { result.current.cancelEdit(); });
    expect(result.current.editing).not.toBeNull();

    await act(async () => { resolveSave(); await commitPromise; });
  });
});
