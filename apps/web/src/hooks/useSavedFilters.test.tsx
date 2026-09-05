import { act, renderHook } from '@testing-library/react';
import { it, expect, describe, beforeEach } from 'vitest';
import { useSavedFilters } from './useSavedFilters';

interface F extends Record<string, unknown> {
  status: string;
}

const KEY = 'sto_filters_test';

describe('useSavedFilters', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('початковий стан: порожній масив (SSR-safe)', () => {
    const { result } = renderHook(() => useSavedFilters<F>('test'));
    expect(result.current.saved).toEqual([]);
  });

  it('hydrates з localStorage у useEffect', () => {
    const preset = { id: 'p1', name: 'A', filters: { status: 'X' }, createdAt: 1 };
    localStorage.setItem(KEY, JSON.stringify([preset]));
    const { result } = renderHook(() => useSavedFilters<F>('test'));
    expect(result.current.saved).toEqual([preset]);
  });

  it('save додає новий пресет і записує у localStorage', () => {
    const { result } = renderHook(() => useSavedFilters<F>('test'));
    let preset!: { id: string; name: string };
    act(() => {
      preset = result.current.save('Активні', { status: 'IN_PROGRESS' });
    });
    expect(result.current.saved).toHaveLength(1);
    expect(result.current.saved[0].name).toBe('Активні');
    expect(preset.id).toBeTruthy();
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown[];
    expect(stored).toHaveLength(1);
  });

  it('remove видаляє пресет за id', () => {
    const { result } = renderHook(() => useSavedFilters<F>('test'));
    let preset!: { id: string };
    act(() => {
      preset = result.current.save('A', { status: 'X' });
    });
    act(() => {
      result.current.remove(preset.id);
    });
    expect(result.current.saved).toHaveLength(0);
  });

  it('rename оновлює name за id', () => {
    const { result } = renderHook(() => useSavedFilters<F>('test'));
    let preset!: { id: string };
    act(() => {
      preset = result.current.save('Old', { status: 'X' });
    });
    act(() => {
      result.current.rename(preset.id, 'New');
    });
    expect(result.current.saved[0].name).toBe('New');
  });

  it('corruption defense: невалідний JSON → []', () => {
    localStorage.setItem(KEY, '{not valid json}');
    const { result } = renderHook(() => useSavedFilters<F>('test'));
    expect(result.current.saved).toEqual([]);
  });

  it('corruption defense: валідний JSON але не масив → []', () => {
    localStorage.setItem(KEY, JSON.stringify({ junk: 1 }));
    const { result } = renderHook(() => useSavedFilters<F>('test'));
    expect(result.current.saved).toEqual([]);
  });

  it('corruption defense: примітив (число) → []', () => {
    localStorage.setItem(KEY, JSON.stringify(42));
    const { result } = renderHook(() => useSavedFilters<F>('test'));
    expect(result.current.saved).toEqual([]);
  });

  // ─── Feature 1: Saved Views (filters + columns + order + sort) ─────────────

  it('save з extra зберігає columns/order/sort у пресеті й localStorage', () => {
    const { result } = renderHook(() => useSavedFilters<F>('test'));
    let preset!: { id: string; columns?: string[]; order?: string[]; sort?: unknown };
    act(() => {
      preset = result.current.save(
        'Подання',
        { status: 'IN_PROGRESS' },
        {
          columns: ['number', 'status'],
          order: ['status', 'number'],
          sort: { field: 'number', dir: 'asc' },
        },
      );
    });
    expect(preset.columns).toEqual(['number', 'status']);
    expect(preset.order).toEqual(['status', 'number']);
    expect(preset.sort).toEqual({ field: 'number', dir: 'asc' });
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Array<{
      columns?: string[];
      sort?: unknown;
    }>;
    expect(stored[0].columns).toEqual(['number', 'status']);
    expect(stored[0].sort).toEqual({ field: 'number', dir: 'asc' });
  });

  it('save без extra не додає view-полів (back-compat формат)', () => {
    const { result } = renderHook(() => useSavedFilters<F>('test'));
    let preset!: Record<string, unknown>;
    act(() => {
      preset = result.current.save('Лише фільтр', { status: 'X' }) as unknown as Record<
        string,
        unknown
      >;
    });
    expect('columns' in preset).toBe(false);
    expect('order' in preset).toBe(false);
    expect('sort' in preset).toBe(false);
  });

  it('back-compat: старий запис без columns/sort гідратується без помилок', () => {
    // Запис у старому форматі (лише id/name/filters/createdAt).
    localStorage.setItem(
      KEY,
      JSON.stringify([{ id: 'old', name: 'Старий', filters: { status: 'X' }, createdAt: 1 }]),
    );
    const { result } = renderHook(() => useSavedFilters<F>('test'));
    expect(result.current.saved).toHaveLength(1);
    expect(result.current.saved[0].columns).toBeUndefined();
    expect(result.current.saved[0].sort).toBeUndefined();
  });

  it('різні pageKey мають незалежне сховище', () => {
    const { result: a } = renderHook(() => useSavedFilters<F>('page-a'));
    const { result: b } = renderHook(() => useSavedFilters<F>('page-b'));
    act(() => {
      a.current.save('Filter A', { status: 'X' });
    });
    expect(a.current.saved).toHaveLength(1);
    expect(b.current.saved).toHaveLength(0);
  });
});
