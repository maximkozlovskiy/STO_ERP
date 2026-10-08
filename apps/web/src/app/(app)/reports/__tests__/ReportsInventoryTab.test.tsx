// Вкладка «Залишки» переїхала зі сторінки «Склад» у «Звіти» (рішення власника 2026-10-08), а
// доступ до неї лишився тим самим: комірник і приймальник заходять у «Звіти», але бачать ЛИШЕ
// «Залишки» — фінансові звіти для них закриті, і запит по них не має піти взагалі.
//
// Mutation-verify: (1) `tab` брати з URL без огляду на роль → кейс «фінансовий запит не йде»
// падає; (2) не фільтрувати `tabs` за роллю → кейс «лише одна вкладка» падає; (3) прибрати
// рендер <InventoryTab /> → кейси «бачить залишки» падають.

import { render, screen, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const replaceMock = vi.fn();
let currentSearch = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => '/reports',
}));

let role = 'OWNER';
const requireAuthMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  useRequireAuth: (roles: string[]) => {
    requireAuthMock(roles);
    return { employee: { id: 'e1', role } };
  },
  useAuth: () => ({ employee: { id: 'e1', role } }),
}));

const useReportMock = vi.fn();
vi.mock('@/hooks/api/useReports', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/useReports')>();
  return {
    ...actual,
    useReport: (tab: string, from: string, to: string) => {
      useReportMock(tab, from, to);
      return { data: undefined, isLoading: false, error: null, isPlaceholderData: false };
    },
  };
});

vi.mock('../../inventory/InventoryTab', () => ({
  InventoryTab: () => <div data-testid="inventory-tab">залишки</div>,
}));
vi.mock('../ReportBuilder', () => ({ ReportBuilder: () => <div data-testid="builder" /> }));
vi.mock('../../settlements/SettlementsTabContent', () => ({
  SettlementsTabContent: () => <div data-testid="settlements-detail" />,
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));

import ReportsPage from '../page';

const tabButtons = () => screen.getAllByRole('button').map(b => b.textContent);

describe('Звіти — вкладка «Залишки» і ролі', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    useReportMock.mockReset();
    requireAuthMock.mockReset();
    currentSearch = '';
    role = 'OWNER';
  });

  it('сторінку відкривають і фінансові ролі, і комірник з приймальником', () => {
    render(<ReportsPage />);
    expect(requireAuthMock).toHaveBeenCalledWith([
      'OWNER',
      'ADMIN',
      'ACCOUNTANT',
      'STOREKEEPER',
      'RECEPTIONIST',
    ]);
  });

  it.each(['OWNER', 'ADMIN', 'ACCOUNTANT'])(
    '%s бачить усі вкладки, серед них «Залишки» і окремо «Звіт по складу»',
    r => {
      role = r;
      render(<ReportsPage />);
      const tabs = tabButtons();
      expect(tabs).toContain('Залишки');
      expect(tabs).toContain('Звіт по складу');
      expect(tabs).toContain('Виручка');
      expect(tabs).toContain('Конструктор');
    },
  );

  it.each(['STOREKEEPER', 'RECEPTIONIST'])(
    '%s бачить лише одну вкладку — «Залишки», і одразу її вміст',
    r => {
      role = r;
      render(<ReportsPage />);
      expect(tabButtons()).toEqual(['Залишки']);
      expect(screen.getByTestId('inventory-tab')).toBeInTheDocument();
    },
  );

  it.each(['STOREKEEPER', 'RECEPTIONIST'])(
    '%s з прямим посиланням на фінансовий звіт (?tab=revenue) однаково бачить «Залишки», а запит звіту не йде',
    r => {
      role = r;
      currentSearch = 'tab=revenue';
      render(<ReportsPage />);
      expect(screen.getByTestId('inventory-tab')).toBeInTheDocument();
      // 'settlements-detail' — вимкнений запит (enabled:false у useReport): так сторінка «глушить»
      // фіксований звіт для self-contained вкладок.
      expect(useReportMock).toHaveBeenCalled();
      for (const call of useReportMock.mock.calls) expect(call[0]).toBe('settlements-detail');
    },
  );

  it('фінансова роль: ?tab=inventory показує залишки без фільтра дат і без запиту звіту', () => {
    currentSearch = 'tab=inventory';
    render(<ReportsPage />);
    expect(screen.getByTestId('inventory-tab')).toBeInTheDocument();
    for (const call of useReportMock.mock.calls) expect(call[0]).toBe('settlements-detail');
    expect(screen.queryByText('Експорт CSV')).not.toBeInTheDocument();
  });

  it('фінансова роль: за замовчуванням — «Виручка», залишки не рендеряться, запит звіту йде', () => {
    render(<ReportsPage />);
    expect(screen.queryByTestId('inventory-tab')).not.toBeInTheDocument();
    expect(useReportMock.mock.calls[0][0]).toBe('revenue');
  });

  it('клік по «Залишки» ставить ?tab=inventory', () => {
    render(<ReportsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Залишки' }));
    expect(replaceMock).toHaveBeenCalledWith('?tab=inventory', { scroll: false });
  });
});
