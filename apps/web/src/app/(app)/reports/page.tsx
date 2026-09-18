'use client';

import { Suspense } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/auth';
import { useReport, type ReportTab } from '@/hooks/api/useReports';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { cn, escapeCsvCell } from '@/lib/utils';
import { fmtMoney, kyivToday } from '@/lib/format';
import { downloadBlob } from '@/lib/download';
import dynamic from 'next/dynamic';
import { SettlementsTabContent } from '../settlements/SettlementsTabContent';
import { ReportBuilder } from './ReportBuilder';

const RevenueCharts = dynamic(() => import('./ReportsCharts').then(m => m.RevenueCharts), {
  ssr: false,
  loading: () => <div className="h-96 bg-surface-hover animate-pulse rounded-xl" />,
});
const SettlementsChart = dynamic(() => import('./ReportsCharts').then(m => m.SettlementsChart), {
  ssr: false,
  loading: () => <div className="h-52 bg-surface-hover animate-pulse rounded-xl" />,
});
const ProfitabilityChart = dynamic(
  () => import('./ReportsCharts').then(m => m.ProfitabilityChart),
  { ssr: false, loading: () => <div className="h-56 bg-surface-hover animate-pulse rounded-xl" /> },
);
const LoadChart = dynamic(() => import('./ReportsCharts').then(m => m.LoadChart), {
  ssr: false,
  loading: () => <div className="h-72 bg-surface-hover animate-pulse rounded-xl" />,
});

type Tab = ReportTab | 'builder';

type RevenueRow = { date: string; revenue: number; labor: number; parts: number; count: number };
type WorkOrderRow = {
  employeeId: string;
  employeeName: string;
  totalNormoHours: number;
  linesCount: number;
  totalAmount: number;
};
type StockItem = {
  goodName: string;
  goodSku: string | null;
  warehouseName: string;
  unit: string;
  quantity: number;
  available: number;
  value: number;
};
type SettlementRow = { counterpartyId: string; counterpartyName: string; balance: number };
type LoadRow = {
  liftId: string;
  liftName: string;
  zoneName: string;
  totalSlots: number;
  totalHours: number;
  loadPercent: number;
};

type ProfitabilityData = {
  totalRevenue: number;
  totalCost: number;
  totalCostParts: number;
  totalCostLabor: number;
  grossProfit: number;
  margin: number;
  ordersCount: number;
};

type ReportData =
  | { _tab: 'revenue'; totalRevenue: number; totalOrders: number; rows: RevenueRow[] }
  | { _tab: 'work-orders'; totalNormoHours: number; totalAmount: number; rows: WorkOrderRow[] }
  | { _tab: 'stock'; totalValue: number; stockItems: StockItem[] }
  | { _tab: 'settlements'; totalDebit: number; totalCredit: number; rows: SettlementRow[] }
  | { _tab: 'load'; rows: LoadRow[] }
  | ({ _tab: 'profitability' } & ProfitabilityData)
  | { _tab: 'vat'; invoiced: number; purchases: number; net: number; from: string; to: string };

// Thin proxy to lib/format singleton (Intl.NumberFormat module-level). Replaces
// per-render `n.toLocaleString('uk-UA', {...})` × every cell у table-heavy reports.
function fmt(n: number) {
  return fmtMoney(n) + ' ₴';
}

// Local Intl singleton — non-default fraction digit count not in lib/format.
const NUM_FMT_1 = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });
function fmtNum(n: number) {
  return NUM_FMT_1.format(n);
}

// Sv-SE формат сьогоднішньої дати в Kyiv (YYYY-MM-DD) — централізовано у lib/format.kyivToday().

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-surface rounded-xl border border-border p-5">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold text-foreground mt-1">{value}</div>
      {sub && <div className="text-[12px] text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

function ReportsPageClient() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT']);
  const { t } = useTranslation('reports');
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = (searchParams.get('tab') ?? 'revenue') as Tab;
  const setTab = (t: Tab) => router.replace(`?tab=${t}`, { scroll: false });
  // `new Date()` тримати ВСЕРЕДИНІ useState initializer — він викликається
  // тільки на першому render; винесена в render path змінна перевиконується на кожний
  // ререндер + ризик SSR/CSR hydration mismatch.
  const [from, setFrom] = useState(() => `${kyivToday().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(() => kyivToday());

  // 'builder' — окрема self-contained вкладка (не фіксований звіт). Мапимо на
  // 'settlements-detail' лише щоб useReport НЕ слав запит (той tab має enabled:false).
  const reportQuery = useReport(tab === 'builder' ? 'settlements-detail' : tab, from, to);
  const { data: rawData, isLoading: loading, error: queryError } = reportQuery;
  // keepPreviousData повертає старі дані при зміні tab — треба використовувати _tab
  // з реального queryKey (не поточний tab), щоб не рендерити stock-поля для revenue-даних.
  // reportQuery.queryKey = ['reports', tab, from, to] але це поточний tab, не той що в даних.
  // Безпечний варіант: _tab = tab тільки якщо дані свіжі (не placeholder).
  const resolvedTab = !reportQuery.isPlaceholderData ? tab : null;
  const data = rawData && resolvedTab ? ({ ...rawData, _tab: resolvedTab } as ReportData) : null;
  const error = queryError instanceof Error ? queryError.message : '';

  const tabs: { id: Tab; label: string }[] = [
    { id: 'revenue', label: t('page.tabs.revenue') },
    { id: 'work-orders', label: t('page.tabs.workOrders') },
    { id: 'stock', label: t('page.tabs.stock') },
    { id: 'settlements', label: t('page.tabs.settlements') },
    { id: 'settlements-detail', label: t('page.tabs.settlementsDetail') },
    { id: 'load', label: t('page.tabs.load') },
    { id: 'profitability', label: t('page.tabs.profitability') },
    { id: 'vat', label: t('page.tabs.vat') },
    { id: 'builder', label: t('page.tabs.builder') },
  ];

  const needsDates = ['revenue', 'work-orders', 'load', 'stock', 'profitability', 'vat'].includes(
    tab,
  );
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

      {/* Filters — один рядок, приховуємо для вкладок Розрахунки/Конструктор */}
      {!isSettlementsDetail && tab !== 'builder' && (
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
                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
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
      {tab !== 'builder' && (
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
            <div className="space-y-6">
              <div className="grid grid-cols-3 gap-4">
                <StatCard label={t('page.revenue.totalRevenue')} value={fmt(data.totalRevenue)} />
                <StatCard label={t('page.revenue.totalOrders')} value={String(data.totalOrders)} />
                <StatCard
                  label={t('page.revenue.avgCheck')}
                  value={data.totalOrders > 0 ? fmt(data.totalRevenue / data.totalOrders) : '—'}
                />
              </div>
              <RevenueCharts rows={data.rows} />
            </div>
          )}

          {/* Work orders report */}
          {data && data._tab === 'work-orders' && (
            <div className="space-y-6">
              <div className="grid grid-cols-3 gap-4">
                <StatCard
                  label={t('page.workOrders.totalNormoHours')}
                  value={fmtNum(data.totalNormoHours)}
                />
                <StatCard label={t('page.workOrders.totalAmount')} value={fmt(data.totalAmount)} />
                <StatCard label={t('page.workOrders.mechanics')} value={String(data.rows.length)} />
              </div>
              <div className="bg-surface rounded-xl border border-border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('page.workOrders.colMechanic')}</TableHead>
                      <TableHead className="text-right">
                        {t('page.workOrders.colNormoHours')}
                      </TableHead>
                      <TableHead className="text-right">{t('page.workOrders.colLines')}</TableHead>
                      <TableHead className="text-right">{t('page.workOrders.colAmount')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows.map(r => (
                      <TableRow key={r.employeeId}>
                        <TableCell className="font-medium text-foreground">
                          {r.employeeName}
                        </TableCell>
                        <TableCell className="text-right">{fmtNum(r.totalNormoHours)}</TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {r.linesCount}
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {fmt(r.totalAmount)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {/* Stock report */}
          {data && data._tab === 'stock' && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <StatCard
                  label={t('page.stock.itemsCount')}
                  value={String(data.stockItems.length)}
                />
                <StatCard label={t('page.stock.totalValue')} value={fmt(data.totalValue)} />
              </div>
              <div className="bg-surface rounded-xl border border-border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('page.stock.colGood')}</TableHead>
                      <TableHead>{t('page.stock.colWarehouse')}</TableHead>
                      <TableHead className="text-right">{t('page.stock.colQuantity')}</TableHead>
                      <TableHead className="text-right">{t('page.stock.colAvailable')}</TableHead>
                      <TableHead className="text-right">{t('page.stock.colValue')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.stockItems.map((i, idx) => (
                      <TableRow key={idx}>
                        <TableCell>
                          <div className="font-medium text-foreground">{i.goodName}</div>
                          <div className="text-xs text-foreground-faint font-mono">
                            {i.goodSku ?? '—'}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{i.warehouseName}</TableCell>
                        <TableCell className="text-right">
                          {fmtNum(i.quantity)} {i.unit}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right font-medium',
                            i.available <= 0 ? 'text-destructive' : 'text-success',
                          )}
                        >
                          {fmtNum(i.available)}
                        </TableCell>
                        <TableCell className="text-right">{fmt(i.value)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {/* Settlements report */}
          {data && data._tab === 'settlements' && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <StatCard
                  label={t('page.settlements.totalDebit')}
                  value={fmt(data.totalDebit)}
                  sub={t('page.settlements.totalDebitSub')}
                />
                <StatCard
                  label={t('page.settlements.totalCredit')}
                  value={fmt(data.totalCredit)}
                  sub={t('page.settlements.totalCreditSub')}
                />
              </div>
              <div className="grid grid-cols-2 gap-6">
                <SettlementsChart rows={data.rows} />
                <div className="bg-surface rounded-xl border border-border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('page.settlements.colCounterparty')}</TableHead>
                        <TableHead className="text-right">
                          {t('page.settlements.colBalance')}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.rows
                        .filter(r => r.balance !== 0)
                        .map(r => (
                          <TableRow key={r.counterpartyId}>
                            <TableCell className="text-foreground">{r.counterpartyName}</TableCell>
                            <TableCell
                              className={cn(
                                'text-right font-semibold',
                                r.balance > 0 ? 'text-destructive' : 'text-success',
                              )}
                            >
                              {r.balance > 0 ? '+' : ''}
                              {fmt(r.balance)}
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          )}

          {/* Profitability report */}
          {data && data._tab === 'profitability' && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <StatCard
                  label={t('page.profitability.revenue')}
                  value={fmt(data.totalRevenue)}
                  sub={t('page.profitability.revenueSub', { count: data.ordersCount })}
                />
                <StatCard
                  label={t('page.profitability.cost')}
                  value={fmt(data.totalCost)}
                  sub={t('page.profitability.costSub', { parts: fmt(data.totalCostParts) })}
                />
                <StatCard
                  label={t('page.profitability.grossProfit')}
                  value={fmt(data.grossProfit)}
                />
                <StatCard
                  label={t('page.profitability.margin')}
                  value={`${data.margin.toFixed(1)}%`}
                  sub={
                    data.margin >= 30
                      ? t('page.profitability.marginOk')
                      : t('page.profitability.marginLow')
                  }
                />
              </div>
              <ProfitabilityChart data={data} />
              <div className="bg-surface rounded-xl border border-border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('page.profitability.colIndicator')}</TableHead>
                      <TableHead className="text-right">
                        {t('page.profitability.colAmount')}
                      </TableHead>
                      <TableHead className="text-right">
                        {t('page.profitability.colPctOfRevenue')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[
                      {
                        id: 'revenue',
                        label: t('page.profitability.rowRevenue'),
                        value: data.totalRevenue,
                        pct: 100,
                      },
                      {
                        id: 'parts',
                        label: t('page.profitability.rowParts'),
                        value: data.totalCostParts,
                        pct:
                          data.totalRevenue > 0
                            ? (data.totalCostParts / data.totalRevenue) * 100
                            : 0,
                      },
                      {
                        id: 'labor',
                        label: t('page.profitability.rowLabor'),
                        value: data.totalCostLabor,
                        pct:
                          data.totalRevenue > 0
                            ? (data.totalCostLabor / data.totalRevenue) * 100
                            : 0,
                      },
                      {
                        id: 'grossProfit',
                        label: t('page.profitability.rowGrossProfit'),
                        value: data.grossProfit,
                        pct: data.margin,
                      },
                    ].map(row => (
                      <TableRow key={row.id}>
                        <TableCell className="text-foreground">{row.label}</TableCell>
                        <TableCell
                          className={cn(
                            'text-right font-semibold',
                            row.id === 'grossProfit'
                              ? row.value >= 0
                                ? 'text-success'
                                : 'text-destructive'
                              : '',
                          )}
                        >
                          {fmt(row.value)}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {row.pct.toFixed(1)}%
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {/* Load report */}
          {data && data._tab === 'load' && (
            <div className="space-y-6">
              <LoadChart rows={data.rows} />
              <div className="bg-surface rounded-xl border border-border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('page.load.colLift')}</TableHead>
                      <TableHead>{t('page.load.colZone')}</TableHead>
                      <TableHead className="text-right">{t('page.load.colSlots')}</TableHead>
                      <TableHead className="text-right">{t('page.load.colHours')}</TableHead>
                      <TableHead className="text-right">{t('page.load.colLoad')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows.map(r => (
                      <TableRow key={r.liftId}>
                        <TableCell className="font-medium text-foreground">{r.liftName}</TableCell>
                        <TableCell className="text-muted-foreground">{r.zoneName}</TableCell>
                        <TableCell className="text-right">{r.totalSlots}</TableCell>
                        <TableCell className="text-right">
                          {fmtNum(r.totalHours)}
                          {t('page.load.hoursSuffix')}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-24 bg-secondary rounded-full h-2">
                              <div
                                className="bg-primary h-2 rounded-full"
                                style={{ width: `${Math.min(r.loadPercent, 100)}%` }}
                              />
                            </div>
                            <span
                              className={cn(
                                'text-xs font-medium',
                                r.loadPercent >= 80
                                  ? 'text-destructive'
                                  : r.loadPercent >= 50
                                    ? 'text-warning'
                                    : 'text-success',
                              )}
                            >
                              {r.loadPercent}%
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
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

function buildCsv(tab: Tab, data: ReportData, t: TFunction<'reports'>): string {
  if (tab === 'revenue' && data._tab === 'revenue') {
    const rows = [
      [
        t('page.csv.date'),
        t('page.csv.revenue'),
        t('page.csv.labor'),
        t('page.csv.parts'),
        t('page.csv.ordersCount'),
      ],
      ...data.rows.map(r => [r.date, r.revenue, r.labor, r.parts, r.count]),
    ];
    return rows.map(r => r.map(c => escapeCsvCell(c)).join(';')).join('\n');
  }
  if (tab === 'work-orders' && data._tab === 'work-orders') {
    const rows = [
      [t('page.csv.mechanic'), t('page.csv.normoHours'), t('page.csv.lines'), t('page.csv.amount')],
      ...data.rows.map(r => [r.employeeName, r.totalNormoHours, r.linesCount, r.totalAmount]),
    ];
    return rows.map(r => r.map(c => escapeCsvCell(c)).join(';')).join('\n');
  }
  if (tab === 'stock' && data._tab === 'stock') {
    const rows = [
      [
        t('page.csv.good'),
        t('page.csv.warehouse'),
        t('page.csv.quantity'),
        t('page.csv.available'),
        t('page.csv.value'),
      ],
      ...data.stockItems.map(i => [i.goodName, i.warehouseName, i.quantity, i.available, i.value]),
    ];
    return rows.map(r => r.map(c => escapeCsvCell(c)).join(';')).join('\n');
  }
  if (tab === 'settlements' && data._tab === 'settlements') {
    const rows = [
      [t('page.csv.counterparty'), t('page.csv.balance')],
      ...data.rows.map(r => [r.counterpartyName, r.balance]),
    ];
    return rows.map(r => r.map(c => escapeCsvCell(c)).join(';')).join('\n');
  }
  if (tab === 'load' && data._tab === 'load') {
    const rows = [
      [
        t('page.csv.lift'),
        t('page.csv.zone'),
        t('page.csv.slots'),
        t('page.csv.hours'),
        t('page.csv.loadPercent'),
      ],
      ...data.rows.map(r => [
        r.liftName,
        r.zoneName,
        r.totalSlots,
        r.totalHours.toFixed(1),
        r.loadPercent,
      ]),
    ];
    return rows.map(r => r.map(c => escapeCsvCell(c)).join(';')).join('\n');
  }
  if (tab === 'profitability' && data._tab === 'profitability') {
    const rows = [
      [t('page.csv.indicator'), t('page.csv.amount'), t('page.csv.pctOfRevenue')],
      [t('page.csv.revenue'), data.totalRevenue, '100.0'],
      [
        t('page.csv.profParts'),
        data.totalCostParts,
        data.totalRevenue > 0 ? ((data.totalCostParts / data.totalRevenue) * 100).toFixed(1) : '0',
      ],
      [
        t('page.csv.profLabor'),
        data.totalCostLabor,
        data.totalRevenue > 0 ? ((data.totalCostLabor / data.totalRevenue) * 100).toFixed(1) : '0',
      ],
      [t('page.csv.grossProfit'), data.grossProfit, data.margin.toFixed(1)],
    ];
    return rows.map(r => r.map(c => escapeCsvCell(c)).join(';')).join('\n');
  }
  return '';
}
