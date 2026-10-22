import type { ReactNode } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n/config';

import { TopShell } from '../TopShell';

/**
 * Оболонка (sidebar, футер користувача, мобільна шапка, підтвердження виходу) переведена на t()
 * (батч D i18n-техборгу). uk — ті самі тексти, що до перекладу; en — без українських рядків,
 * роль користувача — через employeeRoleLabel (statuses:EMPLOYEE_ROLE).
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('next/dynamic', () => ({ default: () => () => null }));

vi.mock('@/lib/auth', () => ({
  isPublicRoute: () => false,
  useAuth: () => ({
    employee: { id: 'u1', firstName: 'Ivan', lastName: 'Koval', role: 'ADMIN' },
    isLoading: false,
    logout: vi.fn(() => Promise.resolve()),
    logoutAll: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({
    commandPaletteEnabled: true,
    syncIndicatorEnabled: false,
    notificationCenterEnabled: false,
    keyboardShortcutsEnabled: false,
  }),
}));

vi.mock('@/hooks/useNavConfig', async () => {
  const { EMPTY_NAV_LAYOUT } = await import('@/lib/nav-layout');
  return { useNavConfig: () => ({ layout: EMPTY_NAV_LAYOUT }) };
});

vi.mock('@/components/TabBar', () => ({ TabBar: () => null }));
vi.mock('@/components/RestoredDocumentModal', () => ({ RestoredDocumentModal: () => null }));
vi.mock('@/components/ui/NavEditor', () => ({ NavEditor: () => null }));
vi.mock('@/hooks/useKeyboardShortcut', () => ({ useKeyboardShortcut: () => {} }));
vi.mock('@/hooks/useGlobalShortcuts', () => ({ useGlobalShortcuts: () => {} }));

const CYRILLIC = /[А-Яа-яІіЇїЄєҐґ]/;

function renderShell(): void {
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  render(<TopShell>content</TopShell>, { wrapper });
}

describe('TopShell — тексти оболонки за мовою інтерфейсу', () => {
  afterEach(async () => {
    await i18n.changeLanguage('uk');
  });

  it('uk — підпис, пошук, меню, роль і кнопки виходу без змін', () => {
    renderShell();
    expect(screen.getAllByText('Автосервіс').length).toBeGreaterThan(0);
    expect(screen.getByText('Пошук...')).toBeInTheDocument();
    expect(screen.getByText('Налаштувати меню')).toBeInTheDocument();
    expect(screen.getByText('Адміністратор')).toBeInTheDocument();
    expect(screen.getByTitle('Згорнути')).toBeInTheDocument();
    expect(screen.getByTitle('Вийти на всіх пристроях')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Відкрити меню' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Відкрити пошук' })).toBeInTheDocument();
    expect(screen.getAllByTitle('Додати закладку').length).toBeGreaterThan(0);
  });

  it('uk — підтвердження виходу на всіх пристроях', async () => {
    renderShell();
    fireEvent.click(screen.getByTitle('Вийти на всіх пристроях'));
    expect(
      await screen.findByRole('dialog', { name: 'Вийти на всіх пристроях?' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Усі активні сесії цього користувача (на всіх пристроях) буде завершено.'),
    ).toBeInTheDocument();
  });

  it('en — оболонка без жодного українського тексту', async () => {
    await i18n.changeLanguage('en');
    renderShell();
    expect(screen.getByText('Car service')).toBeInTheDocument();
    expect(screen.getByText('Customize menu')).toBeInTheDocument();
    expect(screen.getByText('Administrator')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(CYRILLIC);
    const titled = Array.from(document.body.querySelectorAll('[title],[aria-label]'));
    for (const el of titled) {
      const text = `${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
      expect(text).not.toMatch(CYRILLIC);
    }
  });

  it('en — підтвердження виходу англійською', async () => {
    await i18n.changeLanguage('en');
    renderShell();
    fireEvent.click(screen.getByTitle('Sign out'));
    expect(await screen.findByRole('dialog', { name: 'Sign out?' })).toBeInTheDocument();
  });
});
