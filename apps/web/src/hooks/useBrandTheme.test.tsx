// Шапка меню (рішення власника 2026-10-29): назва організації, під нею «OneService». Назва йде з
// `GET /settings/branding` (усі ролі) і кешується, щоб шапка не мигала «OneService» → назва.
//
// Mutation-verify (2026-10-29): без запису в localStorage → падає «кеш»; без читання кешу до
// відповіді API → падає «з першого кадру»; `orgName` з кешу при `enabled=false` → падає «вимкнено».
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { useBrandTheme } from './useBrandTheme';

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

describe('useBrandTheme — назва організації', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('style');
    apiFetchMock.mockReset();
  });

  it('назва з API, і кеш для наступного завантаження', async () => {
    apiFetchMock.mockResolvedValue({ brandTheme: 'green', orgName: 'СТО «Мотор»' });
    const { result } = renderHook(() => useBrandTheme(true), { wrapper });
    await waitFor(() => expect(result.current.orgName).toBe('СТО «Мотор»'));
    expect(apiFetchMock).toHaveBeenCalledWith('/settings/branding');
    expect(localStorage.getItem('sto_org_name')).toBe('СТО «Мотор»');
    expect(document.documentElement.style.getPropertyValue('--color-brand-600')).toBe('#16a34a');
  });

  it('з першого кадру — назва з кешу, поки API не відповів', () => {
    localStorage.setItem('sto_org_name', 'СТО «Мотор»');
    apiFetchMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useBrandTheme(true), { wrapper });
    expect(result.current.orgName).toBe('СТО «Мотор»');
  });

  it('назву в організації стерли → кеш прибирається, шапка — «OneService»', async () => {
    localStorage.setItem('sto_org_name', 'Стара назва');
    apiFetchMock.mockResolvedValue({ brandTheme: 'blue', orgName: null });
    const { result } = renderHook(() => useBrandTheme(true), { wrapper });
    await waitFor(() => expect(result.current.orgName).toBeNull());
    expect(localStorage.getItem('sto_org_name')).toBeNull();
  });

  it('вимкнено (сторінка входу) — без запиту й без назви з кешу', () => {
    localStorage.setItem('sto_org_name', 'СТО «Мотор»');
    const { result } = renderHook(() => useBrandTheme(false), { wrapper });
    expect(result.current.orgName).toBeNull();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
