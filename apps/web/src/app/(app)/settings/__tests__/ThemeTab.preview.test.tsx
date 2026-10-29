// «Налаштування → Оформлення»: клік по палітрі — лише перегляд до «Зберегти». До фіксу неприйнята
// палітра лишалась на весь застосунок після виходу з вкладки (і в кеші `<head>`-скрипта), а шапка
// меню після збереження не перечитувала палітру й назву організації (`GET /settings/branding`).

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const refreshBrandingMock = vi.fn();
vi.mock('@/hooks/useBrandTheme', () => ({
  useRefreshBranding: () => refreshBrandingMock,
}));

vi.mock('@/hooks/useLanguage', () => ({
  useLanguage: () => ({ locale: 'uk', setLanguage: vi.fn() }),
}));

import ThemeTab from '../ThemeTab';
import { THEMES } from '@/lib/theme';

const brand600 = () => document.documentElement.style.getPropertyValue('--color-brand-600');

function mockApi(brandTheme: string) {
  apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/settings/organisation' && init?.method === 'PATCH') {
      return Promise.resolve({ brandTheme: JSON.parse(String(init.body)).brandTheme });
    }
    return Promise.resolve({ brandTheme });
  });
}

describe('ThemeTab — перегляд палітри', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    refreshBrandingMock.mockReset();
    document.documentElement.removeAttribute('style');
  });

  it('пішли з вкладки без «Зберегти» — повертається збережена палітра', async () => {
    mockApi('blue');
    const { unmount } = render(<ThemeTab />);
    fireEvent.click(await screen.findByRole('button', { name: THEMES.purple.label }));
    expect(brand600()).toBe(THEMES.purple.scale![6]);

    unmount();

    expect(brand600()).toBe('');
    expect(refreshBrandingMock).not.toHaveBeenCalled();
  });

  it('збережена палітра лишається після виходу, шапка меню перечитує оформлення', async () => {
    mockApi('blue');
    const { unmount } = render(<ThemeTab />);
    fireEvent.click(await screen.findByRole('button', { name: THEMES.green.label }));
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти тему' }));
    await waitFor(() => expect(refreshBrandingMock).toHaveBeenCalledTimes(1));

    unmount();

    expect(brand600()).toBe(THEMES.green.scale![6]);
  });
});
