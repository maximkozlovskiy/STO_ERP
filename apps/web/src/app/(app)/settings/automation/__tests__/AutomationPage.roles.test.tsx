// Regression-guard (Bug #1004): «Налаштування → Автоматизація» — лише OWNER / ADMIN (BR-AUT-001).
// Інша роль, що прийшла за прямою адресою, не має слати жодного запиту автоматизації: редирект на
// /403 іде ефектом після першого рендеру, а запит правил гейтився лише наявністю працівника —
// механік отримував `GET /automation/rules` → 403 (двічі, з повтором).

import { render, screen } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

let role = 'OWNER';
vi.mock('@/lib/auth', () => ({
  useRequireAuth: (roles?: string[]) => ({
    employee: { role },
    isLoading: false,
    isAuthorized: !roles || roles.includes(role),
  }),
  useAuth: () => ({ employee: { role } }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/settings/automation',
}));
vi.mock('@/hooks/useListPage', () => ({
  useListPage: (_key: string, columns: { key: string; label: string }[]) => ({
    tableColumns: { visibleColumns: columns },
    dragProps: () => ({}),
  }),
}));
vi.mock('@/hooks/useUiFeatures', () => ({ useUiFeatures: () => ({ toastEnabled: false }) }));

const rulesEnabled: boolean[] = [];
vi.mock('@/hooks/api/useAutomation', () => ({
  useAutomationRules: (enabled: boolean) => {
    rulesEnabled.push(enabled);
    return { data: enabled ? { items: [], total: 0 } : undefined, isLoading: false, error: null };
  },
  useToggleAutomationRule: () => ({ mutateAsync: vi.fn() }),
  useDeleteAutomationRule: () => ({ mutateAsync: vi.fn() }),
}));
// Журнал і картка — свої запити; тут перевіряємо, що сторінка їх для чужої ролі не монтує.
vi.mock('@/components/ui/AutomationJournal', () => ({
  AutomationJournal: () => <div data-testid="journal-stub" />,
}));
vi.mock('@/components/ui/AutomationRuleEditModal', () => ({
  AutomationRuleEditModal: () => <div data-testid="rule-card-stub" />,
}));
vi.mock('@/components/ui/columns-dropdown', () => ({ TableColumnsDropdown: () => null }));
vi.mock('@/components/ui/help-popover', () => ({ CatalogHelp: () => null }));

import AutomationSettingsPage from '../page';

describe('Автоматизація — сторінка лише для OWNER / ADMIN (Bug #1004)', () => {
  beforeEach(() => {
    rulesEnabled.length = 0;
    role = 'OWNER';
  });

  it.each(['MECHANIC', 'RECEPTIONIST', 'ACCOUNTANT'])(
    '%s за прямою адресою: запит правил вимкнено, журнал і картка не монтуються',
    r => {
      role = r;
      render(<AutomationSettingsPage />);
      expect(rulesEnabled.length).toBeGreaterThan(0);
      expect(rulesEnabled.every(e => e === false)).toBe(true);
      expect(screen.queryByTestId('rule-card-stub')).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Автоматизація' })).not.toBeInTheDocument();
    },
  );

  it('OWNER: запит правил увімкнено, сторінка рендериться', () => {
    render(<AutomationSettingsPage />);
    expect(rulesEnabled.at(-1)).toBe(true);
    expect(screen.getByTestId('rule-card-stub')).toBeInTheDocument();
  });
});
