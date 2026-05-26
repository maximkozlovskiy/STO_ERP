import { act, renderHook } from '@testing-library/react';
import { it, expect, describe } from 'vitest';
import { useBulkSelect } from './useBulkSelect';

interface Row { id: string; name?: string; }

const items = (ids: string[]): Row[] => ids.map(id => ({ id }));

describe('useBulkSelect', () => {
  it('початковий стан: count=0, selected порожній, allSelected=false', () => {
    const { result } = renderHook(() => useBulkSelect(items(['a', 'b', 'c'])));
    expect(result.current.count).toBe(0);
    expect(result.current.selected.size).toBe(0);
    expect(result.current.allSelected).toBe(false);
    expect(result.current.someSelected).toBe(false);
  });

  it('toggle додає та видаляє ID', () => {
    const { result } = renderHook(() => useBulkSelect(items(['a', 'b', 'c'])));
    act(() => { result.current.toggle('a'); });
    expect(result.current.isSelected('a')).toBe(true);
    expect(result.current.count).toBe(1);
    act(() => { result.current.toggle('a'); });
    expect(result.current.isSelected('a')).toBe(false);
    expect(result.current.count).toBe(0);
  });

  it('toggleAll обирає всі видимі items', () => {
    const { result } = renderHook(() => useBulkSelect(items(['a', 'b', 'c'])));
    act(() => { result.current.toggleAll(); });
    expect(result.current.count).toBe(3);
    expect(result.current.allSelected).toBe(true);
    expect(result.current.someSelected).toBe(false);
  });

  it('toggleAll знімає виборку якщо все було обрано', () => {
    const { result } = renderHook(() => useBulkSelect(items(['a', 'b', 'c'])));
    act(() => { result.current.toggleAll(); });
    act(() => { result.current.toggleAll(); });
    expect(result.current.count).toBe(0);
  });

  it('someSelected=true коли обрана частина', () => {
    const { result } = renderHook(() => useBulkSelect(items(['a', 'b', 'c'])));
    act(() => { result.current.toggle('a'); });
    expect(result.current.someSelected).toBe(true);
    expect(result.current.allSelected).toBe(false);
  });

  it('clear скидає виборку', () => {
    const { result } = renderHook(() => useBulkSelect(items(['a', 'b'])));
    act(() => { result.current.toggleAll(); });
    expect(result.current.count).toBe(2);
    act(() => { result.current.clear(); });
    expect(result.current.count).toBe(0);
  });

  it('items.length=0 → allSelected=false навіть якщо selected=0', () => {
    const { result } = renderHook(() => useBulkSelect(items([])));
    expect(result.current.allSelected).toBe(false);
    expect(result.current.someSelected).toBe(false);
  });

  // Stale-Set pruning — Bug #53 регресія
  it('prunes selected IDs that disappear when items change (Bug #53)', () => {
    const { result, rerender } = renderHook(
      ({ data }: { data: Row[] }) => useBulkSelect(data),
      { initialProps: { data: items(['a', 'b', 'c']) } },
    );

    act(() => {
      result.current.toggle('a');
      result.current.toggle('b');
    });
    expect(result.current.count).toBe(2);

    // Simulate page change — different page, same hook
    rerender({ data: items(['x', 'y', 'z']) });

    // Both 'a' and 'b' should be pruned because they are no longer visible
    expect(result.current.count).toBe(0);
    expect(result.current.isSelected('a')).toBe(false);
    expect(result.current.isSelected('b')).toBe(false);
  });

  it('keeps IDs that remain visible after items change', () => {
    const { result, rerender } = renderHook(
      ({ data }: { data: Row[] }) => useBulkSelect(data),
      { initialProps: { data: items(['a', 'b', 'c']) } },
    );

    act(() => { result.current.toggle('b'); });
    expect(result.current.count).toBe(1);

    // 'b' still in new dataset; 'a' and 'c' replaced
    rerender({ data: items(['b', 'd', 'e']) });

    expect(result.current.isSelected('b')).toBe(true);
    expect(result.current.count).toBe(1);
  });

  it('does not loop / re-render when items reference changes but content equivalent', () => {
    // Just sanity: empty selection should not trigger pruning state update
    const { result, rerender } = renderHook(
      ({ data }: { data: Row[] }) => useBulkSelect(data),
      { initialProps: { data: items(['a', 'b']) } },
    );
    const selectedRef1 = result.current.selected;
    rerender({ data: items(['a', 'b']) });
    // Empty selection short-circuit returns same Set reference (no state update)
    expect(result.current.selected).toBe(selectedRef1);
  });
});
