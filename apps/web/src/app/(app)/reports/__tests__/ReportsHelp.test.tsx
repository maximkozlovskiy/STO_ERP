// Кнопка «?» у рядку фільтрів «Звітів» (рішення власника 2026-10-29): вміст — за поточною
// вкладкою, тексти з дос'є report-builder.md (BR-RPT-023, 030, 031, 033–036) і settlements.md.
// «Рентабельність» підставляє частку праці з відповіді й поріг «Норма» з коду.
//
// Mutation-verify (2026-10-29): одна тема на всі вкладки (`HELP_TOPIC.revenue`) → падають усі,
// крім «Виручки»; `pct` без частки з відповіді → падає «Рентабельність»; без `key={tab}` вікно,
// відкрите на одній вкладці, лишається відкритим на іншій → падає «перемикання вкладки».
import { fireEvent, render, screen, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

let currentSearch = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: (url: string) => {
      currentSearch = url.replace(/^\?/, '');
    },
    push: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => '/reports',
}));
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'e1', role: 'ACCOUNTANT' } }),
  useAuth: () => ({ employee: { id: 'e1', role: 'ACCOUNTANT' } }),
}));

const PROFITABILITY = {
  totalRevenue: 1000,
  totalVat: 200,
  totalRevenueWithVat: 1200,
  totalCost: 350,
  totalCostParts: 200,
  totalCostLabor: 150,
  grossProfit: 650,
  margin: 65,
  ordersCount: 1,
  unknownCostPartsCount: 0,
  laborCostRatio: 0.35,
  from: '2026-01-01',
  to: '2026-10-29',
};
vi.mock('@/hooks/api/useReports', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/useReports')>();
  return {
    ...actual,
    useReport: (tab: string) => ({
      data: tab === 'profitability' ? PROFITABILITY : undefined,
      isLoading: false,
      error: null,
      isPlaceholderData: false,
    }),
  };
});
vi.mock('../../inventory/InventoryTab', () => ({ InventoryTab: () => null }));
vi.mock('../ReportBuilder', () => ({ ReportBuilder: () => null }));
vi.mock('../../settlements/SettlementsTabContent', () => ({ SettlementsTabContent: () => null }));
vi.mock('../ProfitabilityReport', async importOriginal => {
  const actual = await importOriginal<typeof import('../ProfitabilityReport')>();
  return { ...actual, ProfitabilityReport: () => null };
});
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('../ReportGoodCard', () => ({
  useReportGoodCard: () => ({ open: vi.fn(), element: null }),
}));

import ReportsPage from '../page';

function openHelp(): HTMLElement {
  fireEvent.click(within(screen.getByTestId('report-help')).getByRole('button'));
  return screen.getByRole('dialog');
}

describe('Звіти — «?» за вкладкою', () => {
  beforeEach(() => {
    currentSearch = '';
  });

  it.each([
    ['revenue', 'Як рахується «Виручка»', 'до 08.10.2026'],
    ['work-orders', 'Як рахується звіт «Наряди»', 'Скасовані не рахуються'],
    ['stock', 'Як рахується «Звіт по складу»', 'кількість поза партіями'],
    ['settlements', 'Як читати «Взаєморозрахунки»', 'контрагент винен нам'],
    ['load', 'Як рахується «Завантаженість»', '09:00–18:00, пн–пт'],
    ['pnl', 'Як рахується P&L', 'Метод нарахування'],
    ['vat', 'Як рахується «ПДВ»', 'Отримано'],
  ])('%s: «?» пояснює саме цей звіт', (tab, title, phrase) => {
    currentSearch = `tab=${tab}`;
    render(<ReportsPage />);
    const dialog = openHelp();
    expect(dialog).toHaveAccessibleName(title);
    expect(dialog).toHaveTextContent(phrase);
  });

  // guards: BR-RPT-035
  it('«Рентабельність»: частка праці з відповіді і поріг «Норма»', () => {
    currentSearch = 'tab=profitability';
    render(<ReportsPage />);
    const dialog = openHelp();
    expect(dialog).toHaveTextContent('частка праці (35%)');
    expect(dialog).toHaveTextContent('маржа від 30 % і вище');
  });

  it('перемикання вкладки закриває вікно попередньої', () => {
    currentSearch = 'tab=load';
    const { rerender } = render(<ReportsPage />);
    openHelp();
    currentSearch = 'tab=vat';
    rerender(<ReportsPage />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('«Розрахунки» і «Конструктор» — без «?» у рядку фільтрів', () => {
    currentSearch = 'tab=builder';
    render(<ReportsPage />);
    expect(screen.queryByTestId('report-help')).toBeNull();
  });
});
