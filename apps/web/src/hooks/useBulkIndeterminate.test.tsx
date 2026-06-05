import { act, renderHook } from '@testing-library/react';
import { it, expect, describe } from 'vitest';
import { useBulkIndeterminate } from './useBulkIndeterminate';

interface Row {
  id: string;
}
const items = (ids: string[]): Row[] => ids.map(id => ({ id }));

describe('useBulkIndeterminate', () => {
  it('повертає всі поля useBulkSelect + selectAllRef', () => {
    const { result } = renderHook(() => useBulkIndeterminate(items(['a', 'b'])));
    expect(result.current.selectAllRef).toBeDefined();
    expect(result.current.toggle).toBeDefined();
    expect(result.current.toggleAll).toBeDefined();
    expect(result.current.clear).toBeDefined();
    expect(result.current.isSelected).toBeDefined();
    expect(result.current.count).toBe(0);
    expect(result.current.allSelected).toBe(false);
    expect(result.current.someSelected).toBe(false);
  });

  it('встановлює indeterminate=true коли someSelected', () => {
    const { result } = renderHook(() => useBulkIndeterminate(items(['a', 'b', 'c'])));

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    (result.current.selectAllRef as React.MutableRefObject<HTMLInputElement>).current = checkbox;

    act(() => {
      result.current.toggle('a');
    });

    expect(result.current.someSelected).toBe(true);
    expect(checkbox.indeterminate).toBe(true);
  });

  it('встановлює indeterminate=false коли allSelected', () => {
    const { result } = renderHook(() => useBulkIndeterminate(items(['a', 'b'])));

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    (result.current.selectAllRef as React.MutableRefObject<HTMLInputElement>).current = checkbox;

    act(() => {
      result.current.toggleAll();
    });

    expect(result.current.allSelected).toBe(true);
    expect(result.current.someSelected).toBe(false);
    expect(checkbox.indeterminate).toBe(false);
  });

  it('встановлює indeterminate=false коли нічого не обрано', () => {
    const { result } = renderHook(() => useBulkIndeterminate(items(['a', 'b'])));

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    (result.current.selectAllRef as React.MutableRefObject<HTMLInputElement>).current = checkbox;

    act(() => {
      result.current.toggle('a');
    });
    act(() => {
      result.current.clear();
    });

    expect(result.current.someSelected).toBe(false);
    expect(checkbox.indeterminate).toBe(false);
  });

  it('не падає якщо selectAllRef.current = null', () => {
    const { result } = renderHook(() => useBulkIndeterminate(items(['a', 'b'])));
    // ref залишається null — не повинно кидати помилку
    expect(() => {
      act(() => {
        result.current.toggle('a');
      });
    }).not.toThrow();
  });

  it('прунить stale IDs при зміні items (успадковано від useBulkSelect)', () => {
    const { result, rerender } = renderHook(
      ({ data }: { data: Row[] }) => useBulkIndeterminate(data),
      { initialProps: { data: items(['a', 'b']) } },
    );

    act(() => {
      result.current.toggle('a');
    });
    expect(result.current.count).toBe(1);

    rerender({ data: items(['x', 'y']) });
    expect(result.current.count).toBe(0);
  });
});
