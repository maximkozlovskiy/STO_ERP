import { renderHook, act } from '@testing-library/react';
import { it, expect, describe, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { TabBarProvider, useTabBarContext } from '../TabBarContext';

const TABS_KEY = 'sto_modal_tabs';

const wrapper = ({ children }: { children: ReactNode }) => (
  <TabBarProvider>{children}</TabBarProvider>
);

describe('TabBarContext — regression guards', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('Bug #423: loadTabs відкидає невалідні entries (старий kind=page, відсутні поля)', () => {
    const garbageMix = [
      // legacy v1 — kind: 'page' більше не підтримується
      { kind: 'page', id: 'p1', label: 'Стара', href: '/work-orders' },
      // валідна modal tab
      {
        kind: 'modal',
        id: 'm1',
        label: 'WO-001',
        modalKey: 'work-order',
        restoreProps: { workOrderId: 'wo-1' },
      },
      // відсутній restoreProps
      { kind: 'modal', id: 'm2', label: 'Bad', modalKey: 'work-order' },
      // невалідний id
      { kind: 'modal', id: '', label: 'Empty', modalKey: 'x', restoreProps: {} },
      // null/undefined
      null,
      undefined,
      'string-not-object',
    ];
    localStorage.setItem(TABS_KEY, JSON.stringify(garbageMix));

    const { result } = renderHook(() => useTabBarContext(), { wrapper });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0]?.id).toBe('m1');

    // Persisted cleanup: garbage prunned також у localStorage
    const persisted = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]');
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe('m1');
  });

  it('Bug #423: loadTabs не падає на пошкоджений JSON', () => {
    localStorage.setItem(TABS_KEY, '{not valid json[[[');
    const { result } = renderHook(() => useTabBarContext(), { wrapper });
    expect(result.current.tabs).toEqual([]);
  });

  it('Bug #423: loadTabs не падає коли parsed value не Array (null/object)', () => {
    localStorage.setItem(TABS_KEY, JSON.stringify({ not: 'array' }));
    const { result } = renderHook(() => useTabBarContext(), { wrapper });
    expect(result.current.tabs).toEqual([]);
  });

  it('minimizeModal дедуплює tab з однаковим modalKey+workOrderId', () => {
    const { result } = renderHook(() => useTabBarContext(), { wrapper });

    let firstId = '';
    act(() => {
      firstId = result.current.minimizeModal({
        kind: 'modal',
        label: 'WO-001',
        modalKey: 'work-order',
        restoreProps: { workOrderId: 'wo-1' },
      });
    });

    let secondId = '';
    act(() => {
      secondId = result.current.minimizeModal({
        kind: 'modal',
        label: 'WO-001 (оновлено)',
        modalKey: 'work-order',
        restoreProps: { workOrderId: 'wo-1' },
      });
    });

    expect(firstId).toBe(secondId);
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0]?.label).toBe('WO-001 (оновлено)');
  });

  it('minimizeModal не дедуплює різні workOrderId (одна сторінка — різні наряди)', () => {
    const { result } = renderHook(() => useTabBarContext(), { wrapper });

    act(() => {
      result.current.minimizeModal({
        kind: 'modal',
        label: 'WO-A',
        modalKey: 'work-order',
        restoreProps: { workOrderId: 'a' },
      });
      result.current.minimizeModal({
        kind: 'modal',
        label: 'WO-B',
        modalKey: 'work-order',
        restoreProps: { workOrderId: 'b' },
      });
    });

    expect(result.current.tabs).toHaveLength(2);
  });

  it('closeTab видаляє tab з контексту і localStorage', () => {
    const { result } = renderHook(() => useTabBarContext(), { wrapper });

    let id = '';
    act(() => {
      id = result.current.minimizeModal({
        kind: 'modal',
        label: 'WO',
        modalKey: 'work-order',
        restoreProps: { workOrderId: 'x' },
      });
    });

    expect(result.current.tabs).toHaveLength(1);

    act(() => {
      result.current.closeTab(id);
    });

    expect(result.current.tabs).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]')).toHaveLength(0);
  });

  it('Bug #425: restoreModal має стабільну reference між рендерами при зміні tabs', () => {
    const { result, rerender } = renderHook(() => useTabBarContext(), { wrapper });

    const firstRestoreModal = result.current.restoreModal;
    expect(firstRestoreModal).toBeTypeOf('function');

    act(() => {
      result.current.minimizeModal({
        kind: 'modal',
        label: 'X',
        modalKey: 'work-order',
        restoreProps: { workOrderId: 'x' },
      });
    });

    rerender();

    // Stable reference — useCallback з пустим deps + tabsRef
    expect(result.current.restoreModal).toBe(firstRestoreModal);

    // Але повертає актуальний tab (читає з tabsRef.current)
    const tab = result.current.tabs[0];
    expect(tab).toBeDefined();
    expect(result.current.restoreModal(tab!.id)).toEqual(tab);
  });
});
