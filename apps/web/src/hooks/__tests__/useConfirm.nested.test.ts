import { act, renderHook } from '@testing-library/react';
import { it, expect, describe } from 'vitest';
import { useConfirm } from '../useConfirm';

const tick = () => new Promise(r => setTimeout(r, 5));

// `openRef` — «вкладене підтвердження відкрите»: вікно-власник ігнорує свій Escape, поки він стоїть
// (GOTCHAS 2026-10-12). Знімається ПІСЛЯ події відповіді. Гонка (code-review 2026-10-21): виклик
// дочекався відповіді на A й одразу відкрив B — відкладене зняття від A не сміє зняти прапорець B,
// інакше Escape над B закрив би й картку.
describe('useConfirm — openRef', () => {
  it('стоїть, поки підтвердження відкрите, і знімається після відповіді', async () => {
    const { result } = renderHook(() => useConfirm());
    let p!: Promise<boolean>;
    act(() => {
      p = result.current.confirm({ title: 'A' });
    });
    expect(result.current.openRef.current).toBe(true);
    act(() => {
      if (result.current.dialogProps.open) result.current.dialogProps.onConfirm();
    });
    await act(async () => {
      await p;
      await tick();
    });
    expect(result.current.openRef.current).toBe(false);
  });

  it('A відповіли й одразу відкрили B — прапорець B не знімає відкладене зняття від A', async () => {
    const { result } = renderHook(() => useConfirm());
    let pa!: Promise<boolean>;
    act(() => {
      pa = result.current.confirm({ title: 'A' });
    });
    act(() => {
      if (result.current.dialogProps.open) result.current.dialogProps.onConfirm();
    });
    await act(async () => {
      await pa;
      void result.current.confirm({ title: 'B' });
      await tick();
    });
    expect(result.current.dialogProps.open).toBe(true);
    expect(result.current.openRef.current).toBe(true);
  });
});
