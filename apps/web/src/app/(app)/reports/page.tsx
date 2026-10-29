'use client';

import { Suspense } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/auth';
import { useReport, type ReportTab } from '@/hooks/api/useReports';
import { Button } from '@/components/ui/button';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { fmtMoney, kyivToday } from '@/lib/format';
import { InventoryTab } from '../inventory/InventoryTab';
import { downloadBlob } from '@/lib/download';
import dynamic from 'next/dynamic';
import { SettlementsTabContent } from '../settlements/SettlementsTabContent';
import { ReportBuilder } from './ReportBuilder';
import { RevenueReport } from './RevenueReport';
import { PnlReport } from './PnlReport';
import { ProfitabilityReport } from './ProfitabilityReport';
import { QuickPeriods } from './QuickPeriods';
import {
  LoadReportView,
  SettlementsReportView,
  StockReportView,
  WorkOrdersReportView,
} from './ReportTables';
import { useReportGoodCard } from './ReportGoodCard';
import { buildCsv, type ReportData } from './report-csv';
import { CSV_BOM } from '@/lib/report-export';
import { StatCard } from './StatCard';

const RevenueCharts = dynamic(() => import('./ReportsCharts').then(m => m.RevenueCharts), {
  ssr: false,
  loading: () => <div className="h-96 bg-surface-hover animate-pulse rounded-xl" />,
});
const ProfitabilityChart = dynamic(
  () => import('./ReportsCharts').then(m => m.ProfitabilityChart),
  { ssr: false, loading: () => <div className="h-56 bg-surface-hover animate-pulse rounded-xl" /> },
);

type Tab = ReportTab | 'builder' | 'inventory';

// Фінансові звіти — лише цим ролям (так само обмежує бекенд /reports). Комірник і приймальник
// заходять на сторінку заради вкладки «Залишки» (переїхала сюди зі «Складу») і бачать лише її.
const FINANCE_ROLES = ['OWNER', 'ADMIN', 'ACCOUNTANT'];
const INVENTORY_ONLY_ROLES = ['STOREKEEPER', 'RECEPTIONIST'];
// Налаштування P&L (`PATCH /settings/organisation`) і картка товару (`GET /goods/:id`) — лише цим.
const MANAGE_ROLES = ['OWNER', 'ADMIN'];

// Thin proxy to lib/format singleton (Intl.NumberFormat module-level). Replaces
// per-render `n.toLocaleString('uk-UA', {...})` × every cell у table-heavy reports.
function fmt(n: number) {
  return fmtMoney(n) + ' ₴';
}

// Sv-SE формат сьогоднішньої дати в Kyiv (YYYY-MM-DD) — централізовано у lib/format.kyivToday().

function ReportsPageClient() {
  const { employee } = useRequireAuth([...FINANCE_ROLES, ...INVENTORY_ONLY_ROLES]);
  const { t } = useTranslation('reports');
  const router = useRouter();
  const searchParams = useSearchParams();
  // Поки роль невідома (auth ще вантажиться) — вважаємо доступ вузьким: фінансовий запит не
  // має піти раніше, ніж з'ясується, що користувач має на нього право.
  const canSeeFinance = !!employee && FINANCE_ROLES.includes(employee.role);
  const canManage = !!employee && MANAGE_ROLES.includes(employee.role);
  const goodCard = useReportGoodCard();
  const requestedTab = (searchParams.get('tab') ?? 'revenue') as Tab;
  const tab: Tab = canSeeFinance ? requestedTab : 'inventory';
  const setTab = (t: Tab) => router.replace(`?tab=${t}`, { scroll: false });
  // `new Date()` тримати ВСЕРЕДИНІ useState initializer — він викликається
  // тільки на першому render; винесена в render path змінна перевиконується на кожний
  // ререндер + ризик SSR/CSR hydration mismatch.
  const [from, setFrom] = useState(() => `${kyivToday().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(() => kyivToday());

  // 'builder' — окрема self-contained вкладка (не фіксований звіт). Мапимо на
  // 'settlements-detail' лише щоб useReport НЕ слав запит (той tab має enabled:false).
  // 'inventory' — так само self-contained (InventoryTab має власні дані й фільтри).
  const reportQuery = useReport(
    tab === 'builder' || tab === 'inventory' ? 'settlements-detail' : tab,
    from,
    to,
  );
  const { data: rawData, isLoading: loading, error: queryError } = reportQuery;
  // keepPreviousData повертає старі дані при зміні tab — треба використовувати _tab
  // з реального queryKey (не поточний tab), щоб не рендерити stock-поля для revenue-даних.
  // reportQuery.queryKey = ['reports', tab, from, to] але це поточний tab, не той що в даних.
  // Безпечний варіант: _tab = tab тільки якщо дані свіжі (не placeholder).
  const resolvedTab = !reportQuery.isPlaceholderData ? tab : null;
  const data = rawData && resolvedTab ? ({ ...rawData, _tab: resolvedTab } as ReportData) : null;
  const error = queryError instanceof Error ? queryError.message : '';

  const allTabs: { id: Tab; label: string }[] = [
    { id: 'revenue', label: t('page.tabs.revenue') },
    { id: 'work-orders', label: t('page.tabs.workOrders') },
    { id: 'inventory', label: t('page.tabs.inventory') },
    { id: 'stock', label: t('page.tabs.stock') },
    { id: 'settlements', label: t('page.tabs.settlements') },
    { id: 'settlements-detail', label: t('page.tabs.settlementsDetail') },
    { id: 'load', label: t('page.tabs.load') },
    { id: 'profitability', label: t('page.tabs.profitability') },
    { id: 'pnl', label: t('page.tabs.pnl') },
    { id: 'vat', label: t('page.tabs.vat') },
    { id: 'builder', label: t('page.tabs.builder') },
  ];
  const tabs = canSeeFinance ? allTabs : allTabs.filter(x => x.id === 'inventory');

  const needsDates = [
    'revenue',
    'work-orders',
    'load',
    'stock',
    'profitability',
    'pnl',
    'vat',
  ].includes(tab);
  const isSettlementsDetail = tab === 'settlements-detail';

  return (
    <div className="page-fill p-4 md:p-6">
      {error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}
      <h1 className="page-title shrink-0">{t('page.title')}</h1>

      {/* Tabs — стандарт каталогу: border по всій ширині */}
      <div className="shrink-0 flex gap-0 border-b border-border -mx-6 px-6 overflow-x-auto">
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'flex items-center px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0',
              tab === t.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Конструктор — self-contained вкладка (власні фільтри/дані/експорт) */}
      {tab === 'builder' && <ReportBuilder />}

      {/* Залишки — self-contained вкладка (колишня сторінка /inventory) */}
      {tab === 'inventory' && <InventoryTab />}

      {/* Filters — один рядок, приховуємо для вкладок Розрахунки/Конструктор */}
      {!isSettlementsDetail && tab !== 'builder' && tab !== 'inventory' && (
        <div className="flex flex-wrap gap-3 py-4 items-center shrink-0">
          {needsDates && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-muted-foreground shrink-0">
                  {t('page.filters.from')}
                </span>
                <DatePickerInput
                  value={from}
                  onChange={setFrom}
                  placeholder={t('page.filters.datePlaceholder')}
                  className="w-36"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-muted-foreground shrink-0">
                  {t('page.filters.to')}
                </span>
                <DatePickerInput
                  value={to}
                  onChange={setTo}
                  placeholder={t('page.filters.datePlaceholder')}
                  className="w-36"
                />
              </div>
              <QuickPeriods
                from={from}
                to={to}
                onChange={r => {
                  setFrom(r.from);
                  setTo(r.to);
                }}
              />
            </>
          )}
          {loading && (
            <span className="text-xs text-muted-foreground animate-pulse">
              {t('page.filters.loading')}
            </span>
          )}
          {data && (
            <Button
              variant="outline"
              onClick={() => {
                const csv = buildCsv(tab, data, t);
                const blob = new Blob([CSV_BOM + csv], { type: 'text/csv;charset=utf-8;' });
                downloadBlob(blob, `${tab}-report.csv`);
              }}
            >
              {t('page.filters.exportCsv')}
            </Button>
          )}
        </div>
      )}

      {/* Scrollable content area — page-fill = overflow-hidden, тому тут власний скрол.
          Конструктор (builder) рендериться вище (self-contained) → сюди не заходить,
          інакше під ним показувався б порожній placeholder «Оберіть параметри». */}
      {tab !== 'builder' && tab !== 'inventory' && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* Розрахунки — власний split-panel UI, не пов'язаний з useReport */}
          {isSettlementsDetail && <SettlementsTabContent />}

          {!isSettlementsDetail && !data && !loading && (
            <div className="flex items-center justify-center h-64 text-muted-foreground text-[13px]">
              {t('page.empty')}
            </div>
          )}

          {!isSettlementsDetail && loading && (
            <div className="flex items-center justify-center h-64">
              <Spinner size="lg" />
            </div>
          )}

          {/* Revenue report */}
          {data && data._tab === 'revenue' && (
            <RevenueReport data={data} charts={<RevenueCharts rows={data.rows} />} />
          )}

          {/* Work orders report — рядок веде до нарядів механіка за період */}
          {data && data._tab === 'work-orders' && (
            <WorkOrdersReportView data={data} from={from} to={to} />
          )}

          {/* Stock report — рядок відкриває картку товару (OWNER / ADMIN) */}
          {data && data._tab === 'stock' && (
            <StockReportView
              data={data}
              onOpenGood={canManage ? id => void goodCard.open(id) : undefined}
            />
          )}

          {/* Settlements report — рядок веде до картки контрагента */}
          {data && data._tab === 'settlements' && <SettlementsReportView data={data} />}

          {/* Profitability report (BR-RPT-023, BR-RPT-035) */}
          {data && data._tab === 'profitability' && (
            <ProfitabilityReport
              data={data}
              chart={<ProfitabilityChart data={data} />}
              canEditSettings={canManage}
            />
          )}

          {/* P&L (BR-RPT-030) */}
          {data && data._tab === 'pnl' && <PnlReport data={data} canEditSettings={canManage} />}

          {/* Load report */}
          {data && data._tab === 'load' && <LoadReportView data={data} />}
          {/* VAT report */}
          {data && data._tab === 'vat' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <StatCard
                  label={t('page.vat.invoiced')}
                  value={fmt(data.invoiced)}
                  sub={t('page.vat.invoicedSub')}
                />
                <StatCard
                  label={t('page.vat.purchases')}
                  value={fmt(data.purchases)}
                  sub={t('page.vat.purchasesSub')}
                />
                <StatCard
                  label={t('page.vat.net')}
                  value={fmt(data.net)}
                  sub={data.net >= 0 ? t('page.vat.netToPay') : t('page.vat.netRefund')}
                />
              </div>
            </div>
          )}
        </div>
      )}
      {goodCard.element}
    </div>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={null}>
      <ReportsPageClient />
    </Suspense>
  );
}
