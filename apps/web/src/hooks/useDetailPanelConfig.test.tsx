import { act, renderHook, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

// Mock apiFetch — useDetailPanelConfig викликає GET /user-preferences/:key і
// PUT /user-preferences/:key. Без моку jsdom не має fetch і ефекти зависають.
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { useDetailPanelConfig } from './useDetailPanelConfig';

const STORAGE_KEY = 'sto_panel_cfg_crm';
const API_PATH = '/user-preferences/detail_panel_crm';

describe('useDetailPanelConfig', () => {
  beforeEach(() => {
    localStorage.clear();
    apiFetchMock.mockReset();
    // GET за замовчуванням — пустий конфіг з API
    apiFetchMock.mockResolvedValue({ key: 'detail_panel_crm', value: { hiddenFields: [] } });
  });

  it('початковий стан: hiddenFields=[] і loading=true', async () => {
    // API ніколи не резолвиться щоб зафіксувати початковий стан перед completion
    apiFetchMock.mockReturnValueOnce(
      new Promise(() => {
        /* never resolves */
      }),
    );
    const { result } = renderHook(() => useDetailPanelConfig('crm'));
    expect(result.current.config).toEqual({ hiddenFields: [], fieldOrder: [] });
    expect(result.current.loading).toBe(true);
  });

  it('optimistic read з localStorage до резолву API', async () => {
    // localStorage містить попередній збережений конфіг
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ hiddenFields: ['phone', 'email'] }));
    // API ще не резолвиться
    apiFetchMock.mockReturnValueOnce(
      new Promise(() => {
        /* never resolves */
      }),
    );

    const { result } = renderHook(() => useDetailPanelConfig('crm'));
    // localStorage прочитано синхронно — config має одразу містити кеш
    await waitFor(() => {
      expect(result.current.config.hiddenFields).toEqual(['phone', 'email']);
    });
  });

  it('після резолву API — config оновлюється з серверного value', async () => {
    apiFetchMock.mockResolvedValueOnce({
      key: 'detail_panel_crm',
      value: { hiddenFields: ['balance'] },
    });
    const { result } = renderHook(() => useDetailPanelConfig('crm'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.config.hiddenFields).toEqual(['balance']);
    });
    // localStorage оновлено для майбутніх optimistic reads
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      hiddenFields: string[];
    };
    expect(stored.hiddenFields).toEqual(['balance']);
  });

  it("API повертає невалідне value (не об'єкт із hiddenFields) → fallback на порожній", async () => {
    apiFetchMock.mockResolvedValueOnce({ key: 'detail_panel_crm', value: { otherField: 1 } });
    const { result } = renderHook(() => useDetailPanelConfig('crm'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.config.hiddenFields).toEqual([]);
    });
  });

  it('API падає (offline) → loading завершується, config зостається з localStorage', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ hiddenFields: ['edrpou'] }));
    apiFetchMock.mockRejectedValueOnce(new Error('Network error'));
    const { result } = renderHook(() => useDetailPanelConfig('crm'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    // localStorage-fallback зберігся, не перетертий API
    expect(result.current.config.hiddenFields).toEqual(['edrpou']);
  });

  it('toggleField додає поле у hiddenFields і викликає PUT', async () => {
    const { result } = renderHook(() => useDetailPanelConfig('crm'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValue(undefined); // PUT resolves

    act(() => {
      result.current.toggleField('phone');
    });

    expect(result.current.config.hiddenFields).toEqual(['phone']);
    // localStorage оновлено синхронно
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      hiddenFields: string[];
    };
    expect(stored.hiddenFields).toEqual(['phone']);
    // PUT надіслано з правильним body — hook serialises full PanelFieldConfig
    // ({ hiddenFields, fieldOrder }) + AbortSignal для race-protection.
    expect(apiFetchMock).toHaveBeenCalledWith(
      API_PATH,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          key: 'detail_panel_crm',
          value: { hiddenFields: ['phone'], fieldOrder: [] },
        }),
      }),
    );
  });

  it('toggleField повторно для того ж поля — видаляє з hiddenFields', async () => {
    apiFetchMock.mockResolvedValueOnce({
      key: 'detail_panel_crm',
      value: { hiddenFields: ['phone'] },
    });
    const { result } = renderHook(() => useDetailPanelConfig('crm'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    apiFetchMock.mockResolvedValue(undefined);

    act(() => {
      result.current.toggleField('phone');
    });

    expect(result.current.config.hiddenFields).toEqual([]);
  });

  it('WEB-M13: два toggleField в одному tick (до re-render) не губить перший (lost-update)', async () => {
    const { result } = renderHook(() => useDetailPanelConfig('crm'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValue(undefined);

    // Обидва виклики в ОДНОМУ act() — між ними React не re-render-ить, тож captured
    // `config` був би стейл. Правильна реалізація читає configRef.current → чейнінг.
    act(() => {
      result.current.toggleField('phone');
      result.current.toggleField('email');
    });

    // Обидва поля мають потрапити у hiddenFields; при value-based-setState зі стейл-config
    // тут було б лише ['email'] (перший toggle загублений).
    expect(result.current.config.hiddenFields).toEqual(['phone', 'email']);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      hiddenFields: string[];
    };
    expect(stored.hiddenFields).toEqual(['phone', 'email']);
    // Останній PUT несе обидва поля.
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      API_PATH,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          key: 'detail_panel_crm',
          value: { hiddenFields: ['phone', 'email'], fieldOrder: [] },
        }),
      }),
    );
  });

  it('reset очищує hiddenFields, видаляє localStorage і викликає PUT з порожнім value', async () => {
    apiFetchMock.mockResolvedValueOnce({
      key: 'detail_panel_crm',
      value: { hiddenFields: ['phone', 'email'] },
    });
    const { result } = renderHook(() => useDetailPanelConfig('crm'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValue(undefined);

    act(() => {
      result.current.reset();
    });

    expect(result.current.config.hiddenFields).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledWith(
      API_PATH,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          key: 'detail_panel_crm',
          value: { hiddenFields: [], fieldOrder: [] },
        }),
      }),
    );
  });

  it('rapid toggle: попередній PUT abort-нутий перед новим (race protection)', async () => {
    const { result } = renderHook(() => useDetailPanelConfig('crm'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    apiFetchMock.mockClear();

    // Capture AbortSignals з кожного PUT-виклику
    const signals: AbortSignal[] = [];
    apiFetchMock.mockImplementation((_url: string, init: RequestInit) => {
      if (init?.signal) signals.push(init.signal as AbortSignal);
      return new Promise(() => {
        /* never resolves — simulate in-flight */
      });
    });

    act(() => {
      result.current.toggleField('phone');
    });
    act(() => {
      result.current.toggleField('email');
    });
    act(() => {
      result.current.toggleField('balance');
    });

    // 3 виклики, перші 2 signal.aborted=true (abort-нуті), останній — pending
    expect(signals).toHaveLength(3);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(true);
    expect(signals[2].aborted).toBe(false);
  });

  it('різні pageKey мають незалежний storage та API key', async () => {
    apiFetchMock.mockResolvedValueOnce({
      key: 'detail_panel_crm',
      value: { hiddenFields: ['phone'] },
    });
    apiFetchMock.mockResolvedValueOnce({
      key: 'detail_panel_employees',
      value: { hiddenFields: ['role'] },
    });

    const { result: crm } = renderHook(() => useDetailPanelConfig('crm'));
    const { result: emp } = renderHook(() => useDetailPanelConfig('employees'));

    await waitFor(() => {
      expect(crm.current.loading).toBe(false);
      expect(emp.current.loading).toBe(false);
    });

    expect(crm.current.config.hiddenFields).toEqual(['phone']);
    expect(emp.current.config.hiddenFields).toEqual(['role']);
    // Окремі localStorage-ключі
    expect(localStorage.getItem('sto_panel_cfg_crm')).toBeTruthy();
    expect(localStorage.getItem('sto_panel_cfg_employees')).toBeTruthy();
  });

  it('isFieldHidden повертає true для прихованих полів і false для видимих', async () => {
    apiFetchMock.mockResolvedValueOnce({
      key: 'detail_panel_crm',
      value: { hiddenFields: ['phone', 'email'] },
    });
    const { result } = renderHook(() => useDetailPanelConfig('crm'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isFieldHidden('phone')).toBe(true);
    expect(result.current.isFieldHidden('email')).toBe(true);
    expect(result.current.isFieldHidden('balance')).toBe(false);
  });
});
