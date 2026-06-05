'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useRequireAuth } from '@/lib/auth';
import {
  useDashboardOrders,
  useDashboardLowStock,
  useDashboardInvoices,
  useDashboardRevenue,
  useDashboardMaintenance,
} from '@/hooks/api/useDashboardData';
import { useDashboardStream } from '@/hooks/useDashboardStream';
import Link from 'next/link';
import {
  Wrench,
  Clock,
  TrendingUp,
  AlertTriangle,
  FileX,
  BarChart2,
  Plus,
  Users,
  ShoppingCart,
  Receipt,
  CalendarClock,
  Settings2,
  Check,
} from 'lucide-react';
import dynamic from 'next/dynamic';
const RevenueChart = dynamic(() => import('./RevenueChart'), {
  ssr: false,
  loading: () => <div className="h-50 bg-surface-hover animate-pulse rounded-lg" />,
});
import { KpiCard, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageSpinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import { fmtInt, fmtDate, kyivToday } from '@/lib/format';

interface MaintenanceSchedule {
  id: string;
  vehicleId: string;
  vehicleLabel?: string;
  maintenanceType: string;
  intervalDays?: number | null;
  intervalMileage?: number | null;
  nextMaintenanceDate?: string | null;
  nextMaintenanceMileage?: number | null;
  isActive: boolean;
  notes?: string | null;
}

interface KPI {
  openOrders: number;
  inProgressOrders: number;
  completedToday: number;
  revenueToday: number;
  revenueMonth: number;
  lowStockCount: number;
  unpaidInvoices: number;
  unpaidAmount: number;
}

interface RevenueDay {
  date: string;
  revenue: number;
  count: number;
}
interface WorkOrderSummary {
  status: string;
  completedAt?: string | null;
  totalAmount: number;
}
interface InvoiceSummary {
  amount: number;
}
interface PaginatedWorkOrders {
  items: WorkOrderSummary[];
}
interface PaginatedInvoices {
  items: InvoiceSummary[];
}
interface RevenueReport {
  rows: RevenueDay[];
  totalRevenue: number;
}
// Bug #36: правильний тип для відповіді `/stock-items/low`. Раніше було `WorkOrderSummary[]`,
// що проходило TS (типи "довірливі"), але вело до runtime-помилок при доступі до полів.
interface LowStockItem {
  goodId: string;
  goodName: string;
  goodSku: string | null;
  unit: string;
  warehouseName: string;
  quantity: number;
  minStock: number;
  deficit: number;
}

// Thin proxy to lib/format singleton (module-level Intl.NumberFormat). Replaces
// per-render `n.toLocaleString('uk-UA', {...})` × every KPI cell + map row.
function fmt(n: number) {
  return fmtInt(n) + ' ₴';
}

// Module-level Intl singletons — раніше створювались inline у useEffect (loadData kyivDate
// callback + monthStart kyivStr + setTodayStr + greeting hour) = 4 формати на кожен mount.
// Hoist робить кожен виклик дешевим .format() без locale-data init.
// Sv-SE формат сьогоднішньої дати в Kyiv — централізовано у lib/format.kyivToday().
const KYIV_YEAR_MONTH_DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const KYIV_FULL_DATE_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const KYIV_HOUR_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv',
  hour: 'numeric',
  hour12: false,
});

const ALL_QUICK_ACTIONS = [
  { href: '/work-orders', label: 'Новий наряд', icon: Wrench },
  { href: '/counterparties', label: 'Новий клієнт', icon: Users },
  { href: '/purchase-orders', label: 'Замовлення', icon: ShoppingCart },
  { href: '/invoices', label: 'Рахунок', icon: Receipt },
  { href: '/calendar', label: 'Календар', icon: CalendarClock },
  { href: '/inventory', label: 'Склад', icon: BarChart2 },
];

const DEFAULT_QUICK_ACTIONS = ['/work-orders', '/counterparties', '/purchase-orders', '/invoices'];
const QA_STORAGE_KEY = 'sto_quick_actions';

export default function DashboardPage() {
  const { employee } = useRequireAuth();
  const enabled = !!employee;

  const { data: ordersData, isLoading: ordersLoading } = useDashboardOrders(enabled);
  const { data: lowStockData, isLoading: lowStockLoading } = useDashboardLowStock(enabled);
  const { data: invoicesData, isLoading: invoicesLoading } = useDashboardInvoices(enabled);
  const { data: revenueData, isLoading: revenueLoading } = useDashboardRevenue(enabled);
  const { data: maintenanceData } = useDashboardMaintenance(enabled);
  const loading = ordersLoading || lowStockLoading || invoicesLoading || revenueLoading;

  const [error] = useState('');
  const [todayStr, setTodayStr] = useState('');
  const [greeting, setGreeting] = useState('Вітаємо');
  const [enabledQA, setEnabledQA] = useState<string[]>(DEFAULT_QUICK_ACTIONS);
  const [qaConfigOpen, setQaConfigOpen] = useState(false);
  // Bug (review): nowMs з useEffect замість new Date() у render — запобігає SSR hydration mismatch
  // та переобчисленню кожного рядка у .map(). Виставляється після mount.
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    setNowMs(Date.now());
  }, []);

  // F7: Live SSE dashboard stream
  const { data: streamData, isLive } = useDashboardStream();

  // KPI — обчислюється синхронно з TanStack Query даних (no useEffect needed)
  const kpi = useMemo<KPI | null>(() => {
    if (!ordersData || !lowStockData || !invoicesData) return null;
    const today = kyivToday();
    const allOrders: WorkOrderSummary[] =
      (ordersData as { items?: WorkOrderSummary[] }).items ?? [];
    const todayOrders = allOrders.filter(
      o => o.completedAt && o.completedAt.slice(0, 10) === today,
    );
    const allInvoices: InvoiceSummary[] =
      (invoicesData as { items?: InvoiceSummary[] }).items ?? [];
    const kyivStr = KYIV_YEAR_MONTH_DAY_FMT.format(new Date());
    const [kyivYear, kyivMonth] = kyivStr.split('-').map(Number);
    const monthStart = `${kyivYear}-${String(kyivMonth!).padStart(2, '0')}-01`;
    const revRows = (revenueData as { rows?: RevenueDay[] } | undefined)?.rows ?? [];
    const monthRevenue = revRows
      .filter(r => r.date >= monthStart)
      .reduce((s, r) => s + r.revenue, 0);
    const lowArr = Array.isArray(lowStockData) ? lowStockData : [];
    return {
      openOrders: allOrders.filter(o => ['DRAFT', 'ESTIMATE', 'APPROVED'].includes(o.status))
        .length,
      inProgressOrders: allOrders.filter(o => o.status === 'IN_PROGRESS').length,
      completedToday: todayOrders.length,
      revenueToday: todayOrders.reduce((s, o) => s + o.totalAmount, 0),
      revenueMonth: monthRevenue,
      lowStockCount: lowArr.length,
      unpaidInvoices: allInvoices.length,
      unpaidAmount: allInvoices.reduce((s, i) => s + i.amount, 0),
    };
  }, [ordersData, lowStockData, invoicesData, revenueData]);

  const revenue: RevenueDay[] = (revenueData as { rows?: RevenueDay[] } | undefined)?.rows ?? [];
  const upcomingTO: MaintenanceSchedule[] = Array.isArray(maintenanceData)
    ? (maintenanceData as MaintenanceSchedule[])
    : [];

  useEffect(() => {
    setTodayStr(KYIV_FULL_DATE_FMT.format(new Date()));
    const h = parseInt(KYIV_HOUR_FMT.format(new Date()), 10);
    setGreeting(h < 12 ? 'Доброго ранку' : h < 18 ? 'Доброго дня' : 'Доброго вечора');
    try {
      const saved = localStorage.getItem(QA_STORAGE_KEY);
      if (saved) setEnabledQA(JSON.parse(saved) as string[]);
    } catch {
      /* ignore */
    }
  }, []);

  const toggleQA = useCallback((href: string) => {
    setEnabledQA(prev => {
      const next = prev.includes(href) ? prev.filter(h => h !== href) : [...prev, href];
      try {
        localStorage.setItem(QA_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  if (!employee) return null;

  return (
    <div className="page-fill p-4 md:p-6 overflow-y-auto">
      {error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}

      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {greeting}, {employee.firstName}!
          </h1>
          <p className="page-subtitle">{todayStr}</p>
        </div>
      </div>

      {loading ? (
        <PageSpinner />
      ) : !kpi ? (
        <EmptyState title="Немає даних" description="Не вдалося завантажити показники" />
      ) : (
        <>
          {/* Live indicator — F7: SSE stream */}
          {isLive && (
            <div className="flex items-center gap-1.5 text-[12px] text-success mb-3 font-medium">
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
              </span>
              live sync
            </div>
          )}

          {/* KPI grid — 6 рівних карток */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            <Link href="/work-orders" className="flex">
              <KpiCard
                label="В роботі"
                value={streamData?.activeWo ?? kpi.inProgressOrders}
                icon={<Wrench />}
                colorClass="kpi-card-blue"
                trend={{
                  value: `${kpi.completedToday} завершено сьогодні`,
                  up: kpi.completedToday > 0,
                }}
                className="w-full"
              />
            </Link>
            <Link href="/work-orders" className="flex">
              <KpiCard
                label="Очікують"
                value={kpi.openOrders}
                icon={<Clock />}
                colorClass="kpi-card-amber"
                className="w-full"
              />
            </Link>
            <Link href="/reports" className="flex">
              <KpiCard
                label="Виручка сьогодні"
                value={fmt(streamData?.todayRevenue ?? kpi.revenueToday)}
                icon={<TrendingUp />}
                colorClass="kpi-card-green"
                className="w-full"
              />
            </Link>
            <Link href="/reports" className="flex">
              <KpiCard
                label="Виручка за місяць"
                value={fmt(kpi.revenueMonth)}
                icon={<BarChart2 />}
                colorClass="kpi-card-violet"
                className="w-full"
              />
            </Link>
            <Link href="/invoices" className="flex">
              <KpiCard
                label="Несплачені рахунки"
                value={streamData?.pendingInvoices ?? kpi.unpaidInvoices}
                icon={<FileX />}
                colorClass={
                  (streamData?.pendingInvoices ?? kpi.unpaidInvoices) > 0
                    ? 'kpi-card-red'
                    : 'kpi-card-blue'
                }
                trend={
                  kpi.unpaidAmount > 0 ? { value: fmt(kpi.unpaidAmount), up: false } : undefined
                }
                className="w-full"
              />
            </Link>
            <Link href="/inventory" className="flex">
              <KpiCard
                label="Низький залишок"
                value={streamData?.lowStockCount ?? kpi.lowStockCount}
                icon={<AlertTriangle />}
                colorClass={
                  (streamData?.lowStockCount ?? kpi.lowStockCount) > 0
                    ? 'kpi-card-amber'
                    : 'kpi-card-teal'
                }
                className="w-full"
              />
            </Link>
          </div>

          {/* Revenue chart */}
          {revenue.length > 0 ? (
            <Card className="mb-6">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Виручка за 7 днів</CardTitle>
                  <Link
                    href="/reports"
                    className="text-[12px] text-primary hover:underline font-medium"
                  >
                    Всі звіти →
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                <RevenueChart data={revenue} />
              </CardContent>
            </Card>
          ) : null}

          {/* Upcoming maintenance ТО */}
          {upcomingTO.length > 0 && (
            <Card className="mb-6">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <CalendarClock className="h-4 w-4 text-warning" />
                    Наближається ТО ({upcomingTO.length})
                  </CardTitle>
                  <Link
                    href="/counterparties"
                    className="text-[12px] text-primary hover:underline font-medium"
                  >
                    Всі клієнти →
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                <div className="divide-y divide-border">
                  {upcomingTO.slice(0, 8).map(item => {
                    const dateStr = item.nextMaintenanceDate
                      ? fmtDate(item.nextMaintenanceDate)
                      : null;
                    const isOverdue =
                      item.nextMaintenanceDate && nowMs > 0
                        ? new Date(item.nextMaintenanceDate).getTime() < nowMs
                        : false;
                    return (
                      <div key={item.id} className="flex items-center justify-between py-2">
                        <div>
                          <p className="text-[13px] font-medium text-foreground">
                            {item.vehicleLabel ?? item.vehicleId}
                          </p>
                          <p className="text-[12px] text-muted-foreground">
                            {item.maintenanceType === 'REGULAR'
                              ? 'Планове ТО'
                              : item.maintenanceType === 'SEASONAL'
                                ? 'Сезонне ТО'
                                : item.maintenanceType}
                            {item.nextMaintenanceMileage
                              ? ` · ${fmtInt(item.nextMaintenanceMileage)} км`
                              : ''}
                          </p>
                        </div>
                        {dateStr && (
                          <span
                            className={`text-[12px] font-medium px-2 py-0.5 rounded-md ${isOverdue ? 'bg-destructive/10 text-destructive' : 'bg-warning/10 text-warning'}`}
                          >
                            {isOverdue ? 'Прострочено' : dateStr}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Quick actions */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Швидкі дії</CardTitle>
                <button
                  onClick={() => setQaConfigOpen(o => !o)}
                  className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                  title="Налаштувати"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </CardHeader>
            <CardContent>
              {qaConfigOpen && (
                <div className="mb-4 p-3 bg-secondary rounded-lg border border-border">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Оберіть дії
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {ALL_QUICK_ACTIONS.map(({ href, label, icon: Icon }) => {
                      const on = enabledQA.includes(href);
                      return (
                        <button
                          key={href}
                          onClick={() => toggleQA(href)}
                          className={cn(
                            'inline-flex items-center gap-1.5 h-7 px-2.5 text-[12px] font-medium rounded-md border transition-all',
                            on
                              ? 'bg-primary border-primary text-white'
                              : 'bg-surface border-border text-foreground hover:border-border-hover',
                          )}
                        >
                          {on && <Check className="h-3 w-3" />}
                          <Icon className="h-3 w-3" />
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap gap-2.5">
                {ALL_QUICK_ACTIONS.filter(a => enabledQA.includes(a.href)).map(
                  ({ href, label, icon: Icon }) => (
                    <Link
                      key={href}
                      href={href}
                      className="inline-flex items-center gap-1.5 h-8 px-3 text-[13px] font-medium rounded-lg border border-border bg-surface text-foreground hover:bg-secondary hover:border-border-hover transition-all duration-150"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {label}
                    </Link>
                  ),
                )}
                {enabledQA.length === 0 && (
                  <p className="text-[13px] text-muted-foreground">
                    Немає активних дій — натисніть ⚙ щоб налаштувати
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
