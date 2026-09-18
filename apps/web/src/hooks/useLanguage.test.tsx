import { renderHook, waitFor, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { useLanguage } from './useLanguage';
import i18n from '@/i18n/config';

const USER_PREF_PATH = '/user-preferences/locale';

describe('useLanguage', () => {
  beforeEach(() => {
    localStorage.clear();
    apiFetchMock.mockReset();
  });
  afterEach(async () => {
    await i18n.changeLanguage('uk');
  });

  it('резолюція user-override → застосовує мову з /user-preferences', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === USER_PREF_PATH)
        return Promise.resolve({ key: 'locale', value: { locale: 'en' } });
      return Promise.reject(new Error('unexpected'));
    });
    const { result } = renderHook(() => useLanguage());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.locale).toBe('en');
    expect(localStorage.getItem('sto_locale')).toBe('en');
  });

  it('немає user-override → падає на org-default (/settings/organisation)', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === USER_PREF_PATH) return Promise.resolve({ key: 'locale', value: {} });
      if (path === '/settings/organisation') return Promise.resolve({ language: 'en' });
      return Promise.reject(new Error('unexpected'));
    });
    const { result } = renderHook(() => useLanguage());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.locale).toBe('en');
  });

  it('ні override ні org → дефолт uk', async () => {
    apiFetchMock.mockResolvedValue({ value: {} });
    const { result } = renderHook(() => useLanguage());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.locale).toBe('uk');
  });

  it('свіжий localStorage-кеш (TTL) пропускає fetch', async () => {
    localStorage.setItem('sto_locale', 'en');
    localStorage.setItem('sto_locale_ts', String(Date.now()));
    const { result } = renderHook(() => useLanguage());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(result.current.locale).toBe('en');
  });

  it('setLanguage персистить + міняє i18n + PUT', async () => {
    apiFetchMock.mockResolvedValue({ value: {} });
    const { result } = renderHook(() => useLanguage());
    await waitFor(() => expect(result.current.loading).toBe(false));
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValue(undefined);

    act(() => result.current.setLanguage('en'));
    expect(result.current.locale).toBe('en');
    expect(localStorage.getItem('sto_locale')).toBe('en');
    expect(i18n.language).toBe('en');
    expect(apiFetchMock).toHaveBeenCalledWith(
      USER_PREF_PATH,
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('offline (reject) → лишає кеш/дефолт без краху', async () => {
    localStorage.setItem('sto_locale', 'en');
    // старий ts → форсуємо fetch, який впаде
    localStorage.setItem('sto_locale_ts', '0');
    apiFetchMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useLanguage());
    await waitFor(() => expect(result.current.loading).toBe(false));
    // fallback resolved → DEFAULT uk (org недоступний), кеш не ламається
    expect(['uk', 'en']).toContain(result.current.locale);
  });
});
