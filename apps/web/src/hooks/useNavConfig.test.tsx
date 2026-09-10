import { act, renderHook, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { useNavConfig } from './useNavConfig';

const API_PATH = '/user-preferences/nav_layout';

async function mountLoaded() {
  apiFetchMock.mockResolvedValueOnce({ key: 'nav_layout', value: {} });
  const hook = renderHook(() => useNavConfig());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

describe('useNavConfig', () => {
  beforeEach(() => {
    localStorage.clear();
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ key: 'nav_layout', value: {} });
  });

  it('дефолтний стан — порожній layout, loading=false після GET', async () => {
    const { result } = await mountLoaded();
    expect(result.current.layout.hiddenItems).toEqual([]);
    expect(result.current.layout.customSections).toEqual([]);
  });

  it('toggleItem ховає і повертає пункт; PUT викликається', async () => {
    const { result } = await mountLoaded();
    apiFetchMock.mockResolvedValue(undefined);

    act(() => result.current.toggleItem('/cash'));
    expect(result.current.layout.hiddenItems).toEqual(['/cash']);
    expect(apiFetchMock).toHaveBeenCalledWith(API_PATH, expect.objectContaining({ method: 'PUT' }));

    act(() => result.current.toggleItem('/cash'));
    expect(result.current.layout.hiddenItems).toEqual([]);
  });

  it('два toggle різних пунктів в одному tick чейняться (lost-update guard)', async () => {
    const { result } = await mountLoaded();
    apiFetchMock.mockResolvedValue(undefined);

    act(() => {
      result.current.toggleItem('/cash');
      result.current.toggleItem('/invoices');
    });
    expect(result.current.layout.hiddenItems.sort()).toEqual(['/cash', '/invoices']);
  });

  it('addSection додає кастомний розділ і повертає id', async () => {
    const { result } = await mountLoaded();
    apiFetchMock.mockResolvedValue(undefined);

    let id = '';
    act(() => {
      id = result.current.addSection('Мій розділ');
    });
    expect(id).toMatch(/^custom:/);
    expect(result.current.layout.customSections).toEqual([{ id, label: 'Мій розділ' }]);
  });

  it('moveItemToSection ставить override + кінець itemOrder цільової секції', async () => {
    const { result } = await mountLoaded();
    apiFetchMock.mockResolvedValue(undefined);

    act(() => result.current.moveItemToSection('/cash', 'custom:x'));
    expect(result.current.layout.itemSection['/cash']).toBe('custom:x');
    expect(result.current.layout.itemOrder['custom:x']).toEqual(['/cash']);
  });

  it('removeSection повертає пункти у дефолт (прибирає itemSection-override)', async () => {
    const { result } = await mountLoaded();
    apiFetchMock.mockResolvedValue(undefined);

    let id = '';
    act(() => {
      id = result.current.addSection('Тимч');
    });
    act(() => result.current.moveItemToSection('/cash', id));
    expect(result.current.layout.itemSection['/cash']).toBe(id);

    act(() => result.current.removeSection(id));
    expect(result.current.layout.customSections).toEqual([]);
    expect(result.current.layout.itemSection['/cash']).toBeUndefined();
    expect(result.current.layout.itemOrder[id]).toBeUndefined();
  });

  it('reset очищає layout + PUT порожнього', async () => {
    const { result } = await mountLoaded();
    apiFetchMock.mockResolvedValue(undefined);

    act(() => result.current.toggleItem('/cash'));
    expect(result.current.layout.hiddenItems).toEqual(['/cash']);

    act(() => result.current.reset());
    expect(result.current.layout.hiddenItems).toEqual([]);
    expect(localStorage.getItem('sto_nav_layout')).toBeNull();
  });

  it('optimistic read з localStorage до резолву API', async () => {
    localStorage.setItem('sto_nav_layout', JSON.stringify({ hiddenItems: ['/cash'] }));
    apiFetchMock.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => useNavConfig());
    await waitFor(() => expect(result.current.layout.hiddenItems).toEqual(['/cash']));
  });
});
