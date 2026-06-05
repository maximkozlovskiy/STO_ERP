'use client';

import { Suspense } from 'react';
import { useState } from 'react';
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
import { cn } from '@/lib/utils';
import { fmtMoney, kyivToday } from '@/lib/format';
import dynamic from 'next/dynamic';
import { SettlementsTabContent } from '../settlements/SettlementsTabContent';

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

type Tab = ReportTab;

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
  | ({ _tab: 'profitability' } & ProfitabilityData);

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
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = (searchParams.get('tab') ?? 'revenue') as Tab;
  const setTab = (t: Tab) => router.replace(`?tab=${t}`, { scroll: false });
  // Bug #294: `new Date()` тримати ВСЕРЕДИНІ useState initializer — він викликається
  // тільки на першому render; винесена в render path змінна перевиконується на кожний
  // ререндер + ризик SSR/CSR hydration mismatch.
  const [from, setFrom] = useState(() => `${kyivToday().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(() => kyivToday());

  const reportQuery = useReport(tab, from, to);
  const { data: rawData, isLoading: loading, error: queryError } = reportQuery;
  // keepPreviousData повертає старі дані при зміні tab — треба використовувати _tab
  // з реального queryKey (не поточний tab), щоб не рендерити stock-поля для revenue-даних.
  // reportQuery.queryKey = ['reports', tab, from, to] але це поточний tab, не той що в даних.
  // Безпечний варіант: _tab = tab тільки якщо дані свіжі (не placeholder).
  const resolvedTab = !reportQuery.isPlaceholderData ? tab : null;
  const data = rawData && resolvedTab ? ({ ...rawData, _tab: resolvedTab } as ReportData) : null;
  const error = queryError instanceof Error ? queryError.message : '';

  const tabs: { id: Tab; label: string }[] = [
    { id: 'revenue', label: 'Виручка' },
    { id: 'work-orders', label: 'Наряди' },
    { id: 'stock', label: 'Залишки' },
    { id: 'settlements', label: 'Взаєморозрахунки' },
    { id: 'settlements-detail', label: 'Розрахунки' },
    { id: 'load', label: 'Завантаженість' },
    { id: 'profitability', label: 'Рентабельність' },
  ];

  const needsDates = ['revenue', 'work-orders', 'load', 'stock', 'profitability'].includes(tab);
  const isSettlementsDetail = tab === 'settlements-detail';

  return (
    <div className="page-fill p-4 md:p-6">
      {error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}
      <h1 className="page-title shrink-0">Звіти</h1>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border mb-6">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'px-4 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors',
              tab === t.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filters — приховуємо для вкладки Розрахунки (власний UI всередині) */}
      <div className="flex flex-wrap gap-3 mb-6 items-end">
        {needsDates && !isSettlementsDetail && (
          <>
            <DatePickerInput
              label="З"
              value={from}
              onChange={setFrom}
              placeholder="ДД.ММ.РРРР"
              className="w-40"
            />
            <DatePickerInput
              label="По"
              value={to}
              onChange={setTo}
              placeholder="ДД.ММ.РРРР"
              className="w-40"
            />
          </>
        )}
        {!isSettlementsDetail && loading && (
          <span className="text-xs text-muted-foreground animate-pulse">Завантаження…</span>
        )}
        {!isSettlementsDetail && data && (
          <Button
            variant="outline"
            onClick={() => {
              const csv = buildCsv(tab, data);
              const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${tab}-report.csv`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 100);
            }}
          >
            Експорт CSV
          </Button>
        )}
      </div>

      {/* Scrollable content area — page-fill = overflow-hidden, тому тут власний скрол */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Розрахунки — власний split-panel UI, не пов'язаний з useReport */}
        {isSettlementsDetail && <SettlementsTabContent />}

        {!isSettlementsDetail && !data && !loading && (
          <div className="flex items-center justify-center h-64 text-muted-foreground text-[13px]">
            Оберіть параметри і натисніть «Сформувати»
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
              <StatCard label="Загальна виручка" value={fmt(data.totalRevenue)} />
              <StatCard label="Кількість нарядів" value={String(data.totalOrders)} />
              <StatCard
                label="Середній чек"
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
              <StatCard label="Всього норм-годин" value={fmtNum(data.totalNormoHours)} />
              <StatCard label="Сума робіт" value={fmt(data.totalAmount)} />
              <StatCard label="Механіків" value={String(data.rows.length)} />
            </div>
            <div className="bg-surface rounded-xl border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Механік</TableHead>
                    <TableHead className="text-right">Норм-год</TableHead>
                    <TableHead className="text-right">Позицій</TableHead>
                    <TableHead className="text-right">Сума</TableHead>
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
              <StatCard label="Позицій на складах" value={String(data.stockItems.length)} />
              <StatCard label="Загальна вартість" value={fmt(data.totalValue)} />
            </div>
            <div className="bg-surface rounded-xl border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Товар</TableHead>
                    <TableHead>Склад</TableHead>
                    <TableHead className="text-right">Кількість</TableHead>
                    <TableHead className="text-right">Доступно</TableHead>
                    <TableHead className="text-right">Вартість</TableHead>
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
                label="Дебіторська заборгованість"
                value={fmt(data.totalDebit)}
                sub="Клієнти нам"
              />
              <StatCard
                label="Кредиторська заборгованість"
                value={fmt(data.totalCredit)}
                sub="Ми постачальникам"
              />
            </div>
            <div className="grid grid-cols-2 gap-6">
              <SettlementsChart rows={data.rows} />
              <div className="bg-surface rounded-xl border border-border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Контрагент</TableHead>
                      <TableHead className="text-right">Баланс</TableHead>
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
                label="Виручка"
                value={fmt(data.totalRevenue)}
                sub={`${data.ordersCount} нарядів`}
              />
              <StatCard
                label="Собівартість"
                value={fmt(data.totalCost)}
                sub={`Запч: ${fmt(data.totalCostParts)}`}
              />
              <StatCard label="Валовий прибуток" value={fmt(data.grossProfit)} />
              <StatCard
                label="Маржинальність"
                value={`${data.margin.toFixed(1)}%`}
                sub={data.margin >= 30 ? '✓ Норма' : '↓ Нижче норми'}
              />
            </div>
            <ProfitabilityChart data={data} />
            <div className="bg-surface rounded-xl border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Показник</TableHead>
                    <TableHead className="text-right">Сума</TableHead>
                    <TableHead className="text-right">% до виручки</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[
                    { label: 'Виручка', value: data.totalRevenue, pct: 100 },
                    {
                      label: '— Запчастини (собівартість)',
                      value: data.totalCostParts,
                      pct:
                        data.totalRevenue > 0 ? (data.totalCostParts / data.totalRevenue) * 100 : 0,
                    },
                    {
                      label: '— Праця (оцінка 40%)',
                      value: data.totalCostLabor,
                      pct:
                        data.totalRevenue > 0 ? (data.totalCostLabor / data.totalRevenue) * 100 : 0,
                    },
                    { label: 'Валовий прибуток', value: data.grossProfit, pct: data.margin },
                  ].map(row => (
                    <TableRow key={row.label}>
                      <TableCell className="text-foreground">{row.label}</TableCell>
                      <TableCell
                        className={cn(
                          'text-right font-semibold',
                          row.label === 'Валовий прибуток'
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
                    <TableHead>Підйомник</TableHead>
                    <TableHead>Зона</TableHead>
                    <TableHead className="text-right">Слотів</TableHead>
                    <TableHead className="text-right">Годин</TableHead>
                    <TableHead className="text-right">Завантаженість</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map(r => (
                    <TableRow key={r.liftId}>
                      <TableCell className="font-medium text-foreground">{r.liftName}</TableCell>
                      <TableCell className="text-muted-foreground">{r.zoneName}</TableCell>
                      <TableCell className="text-right">{r.totalSlots}</TableCell>
                      <TableCell className="text-right">{fmtNum(r.totalHours)}г</TableCell>
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
      </div>
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

function buildCsv(tab: Tab, data: ReportData): string {
  if (tab === 'revenue' && data._tab === 'revenue') {
    const rows = [
      ['Дата', 'Виручка', 'Роботи', 'Запчастини', 'Нарядів'],
      ...data.rows.map(r => [r.date, r.revenue, r.labor, r.parts, r.count]),
    ];
    return rows.map(r => r.join(';')).join('\n');
  }
  if (tab === 'work-orders' && data._tab === 'work-orders') {
    const rows = [
      ['Механік', 'Норм-год', 'Позицій', 'Сума'],
      ...data.rows.map(r => [r.employeeName, r.totalNormoHours, r.linesCount, r.totalAmount]),
    ];
    return rows.map(r => r.join(';')).join('\n');
  }
  if (tab === 'stock' && data._tab === 'stock') {
    const rows = [
      ['Товар', 'Склад', 'Кількість', 'Доступно', 'Вартість'],
      ...data.stockItems.map(i => [i.goodName, i.warehouseName, i.quantity, i.available, i.value]),
    ];
    return rows.map(r => r.join(';')).join('\n');
  }
  if (tab === 'settlements' && data._tab === 'settlements') {
    const rows = [['Контрагент', 'Баланс'], ...data.rows.map(r => [r.counterpartyName, r.balance])];
    return rows.map(r => r.join(';')).join('\n');
  }
  if (tab === 'load' && data._tab === 'load') {
    const rows = [
      ['Підйомник', 'Зона', 'Слотів', 'Годин', 'Завантаженість%'],
      ...data.rows.map(r => [
        r.liftName,
        r.zoneName,
        r.totalSlots,
        r.totalHours.toFixed(1),
        r.loadPercent,
      ]),
    ];
    return rows.map(r => r.join(';')).join('\n');
  }
  if (tab === 'profitability' && data._tab === 'profitability') {
    const rows = [
      ['Показник', 'Сума', '% до виручки'],
      ['Виручка', data.totalRevenue, '100.0'],
      [
        'Запчастини',
        data.totalCostParts,
        data.totalRevenue > 0 ? ((data.totalCostParts / data.totalRevenue) * 100).toFixed(1) : '0',
      ],
      [
        'Праця',
        data.totalCostLabor,
        data.totalRevenue > 0 ? ((data.totalCostLabor / data.totalRevenue) * 100).toFixed(1) : '0',
      ],
      ['Валовий прибуток', data.grossProfit, data.margin.toFixed(1)],
    ];
    return rows.map(r => r.join(';')).join('\n');
  }
  return '';
}
