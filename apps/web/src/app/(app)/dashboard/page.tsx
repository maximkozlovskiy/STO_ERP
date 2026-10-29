'use client';

import { fillRevenueWeek } from './revenue-week';
import { useEffect, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { WO_EDITABLE_STATUSES } from '@sto/shared';
import { WO_IN_WORK_STATUSES, workOrdersStatusHref } from '../work-orders/url-filter';
import { useRequireAuth } from '@/lib/auth';
import {
  useDashboardOrders,
  useDashboardLowStock,
  useDashboardInvoices,
  useDashboardRevenue,
  useDashboardPnl,
  useDashboardMaintenance,
  dashboardAccess,
} from '@/hooks/api/useDashboardData';
import { CalendarMonthSummary } from '../calendar/CalendarMonthSummary';
import { useMonthSummaryData } from '../calendar/useMonthSummaryData';
import { fmtKyivMonthYear } from '../calendar/calendar.utils';
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
  CalendarDays,
  Settings2,
  Check,
  Wallet,
} from 'lucide-react';
import dynamic from 'next/dynamic';
const RevenueChart = dynamic(() => import('./RevenueChart'), {
  ssr: false,
  loading: () => <div className="h-50 bg-surface-hover animate-pulse rounded-lg" />,
});
import { KpiCard, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageSpinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { cn, roundMoney } from '@/lib/utils';
import { fmtInt, fmtMoney, fmtDate, kyivToday, kyivDateOf, memoByLocale } from '@/lib/format';

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

/** `null` — роль не читає список, з якого рахується показник (Bug #879): картка показує «—». */
interface KPI {
  openOrders: number | null;
  inProgressOrders: number | null;
  completedToday: number | null;
  revenueMonth: number | null;
  /** Чистий прибуток місяця з P&L (BR-RPT-030); `null` — роль без доступу або дані ще йдуть. */
  netProfitMonth: number | null;
  /** За поточний місяць зарплату не розраховано — чистий прибуток завищений. */
  payrollMissing: boolean;
  lowStockCount: number | null;
  unpaidInvoices: number | null;
  unpaidAmount: number | null;
}

interface RevenueDay {
  date: string;
  revenue: number;
  count: number;
}
interface WorkOrderSummary {
  status: string;
  completedAt?: string | null;
}
interface InvoiceSummary {
  amount: number;
  paidAmount?: number;
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
// Correct type for `/stock-items/low` response. Previously `WorkOrderSummary[]`
// passed TS (types were "trusting") but caused runtime errors when accessing fields.
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

// WEB-M9: гроші показуємо з копійками (fmtMoney → «1 250,00»), не fmtInt — інакше KPI відкидає
// копійки (порушення локалі uk-UA). fmtInt лишається для пробігу (км), не грошей.
function fmt(n: number) {
  return fmtMoney(n) + ' ₴';
}

// Stable fallbacks для Bug #328 cascade prevention — `data?.rows ?? []` створював
// fresh array literal кожен render → identity change → downstream useMemo/useEffect
// з deps на цю змінну ре-фаєрить. RevenueChart та upcomingTO .map() прямо не
// мають effect deps, але hoist module-level — як санітарний loop-prevention pattern.
const EMPTY_REVENUE: readonly RevenueDay[] = Object.freeze([]);
const EMPTY_MAINTENANCE: readonly MaintenanceSchedule[] = Object.freeze([]);

// Sv-SE формат сьогоднішньої дати в Kyiv — централізовано у lib/format.kyivToday().
// Дата в привітанні — мовою інтерфейсу (назви дня й місяця).
const getFullDateFmt = memoByLocale(
  loc =>
    new Intl.DateTimeFormat(loc, {
      timeZone: 'Europe/Kyiv',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }),
);
const KYIV_HOUR_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv',
  hour: 'numeric',
  hour12: false,
});

// `href` — ідентифікатор дії у збереженому виборі (`sto_quick_actions`), тому не змінюється; куди
// веде кнопка — `to`. «Новий наряд» / «Новий клієнт» відкривають форму створення (`?action=new`).
const ALL_QUICK_ACTIONS: Array<{
  href: string;
  to?: string;
  labelKey: string;
  icon: typeof Wrench;
}> = [
  { href: '/work-orders', to: '/work-orders?action=new', labelKey: 'workOrders', icon: Wrench },
  {
    href: '/counterparties',
    to: '/counterparties?action=new',
    labelKey: 'counterparties',
    icon: Users,
  },
  { href: '/purchase-orders', labelKey: 'purchaseOrders', icon: ShoppingCart },
  { href: '/invoices', labelKey: 'invoices', icon: Receipt },
  { href: '/calendar', labelKey: 'calendar', icon: CalendarClock },
  { href: '/reports?tab=inventory', labelKey: 'inventory', icon: BarChart2 },
];

const DEFAULT_QUICK_ACTIONS = ['/work-orders', '/counterparties', '/purchase-orders', '/invoices'];
const QA_STORAGE_KEY = 'sto_quick_actions';

export default function DashboardPage() {
  const { t } = useTranslation('dashboard');
  const { employee } = useRequireAuth();
  const enabled = !!employee;
  // Кожен список — лише ролям, яким його віддає API (Bug #879): 403 давав банер помилки й порожній
  // дашборд механіку й приймальні. Виручка — чутлива фін-інформація: для решти ролей ще й графік
  // сховано.
  const access = dashboardAccess(employee?.role);
  const canViewRevenue = access.revenue;

  const {
    data: ordersData,
    isLoading: ordersLoading,
    isError: ordersError,
  } = useDashboardOrders(enabled && access.orders);
  const {
    data: lowStockData,
    isLoading: lowStockLoading,
    isError: lowStockError,
  } = useDashboardLowStock(enabled && access.lowStock);
  const {
    data: invoicesData,
    isLoading: invoicesLoading,
    isError: invoicesError,
  } = useDashboardInvoices(enabled && access.invoices);
  const {
    data: revenueData,
    isLoading: revenueLoading,
    isError: revenueError,
  } = useDashboardRevenue(enabled && canViewRevenue);
  // KPI місяця — з P&L поточного місяця (BR-RPT-030). Раніше «виручка за місяць» сумувала рядки
  // графіка тижня, тобто лише останні 7 днів.
  const { data: pnlData, isError: pnlError } = useDashboardPnl(enabled && canViewRevenue);
  const { data: maintenanceData } = useDashboardMaintenance(enabled && access.maintenance);
  // Підсумки календаря за поточний місяць (BR-CAL-013) — на місці колишнього віджета гарантій.
  const calendarMonth = kyivToday().slice(0, 7);
  const monthSummary = useMonthSummaryData(calendarMonth, enabled && access.calendar);
  const loading = ordersLoading || lowStockLoading || invoicesLoading || revenueLoading;

  // T9: раніше error ніколи не виставлявся → помилка запиту тихо показувала 0/«нема даних»
  // (silent wrong number). Тепер піднімаємо реальний стан помилки з хуків: будь-який fail із
  // core-показників → банер помилки замість оманливих нулів. revenueError окремо не блокує KPI,
  // але додає банер (щоб revenueMonth=0 не читалось як «виторгу немає»).
  const error =
    ordersError || lowStockError || invoicesError || revenueError || pnlError ? t('loadError') : '';
  const [todayStr, setTodayStr] = useState('');
  const [greeting, setGreeting] = useState(() => t('greeting.default'));
  const [enabledQA, setEnabledQA] = useState<string[]>(DEFAULT_QUICK_ACTIONS);
  const [qaConfigOpen, setQaConfigOpen] = useState(false);
  // F7: Live SSE dashboard stream
  const { data: streamData, isLive } = useDashboardStream();

  // KPI — обчислюється синхронно з TanStack Query даних (no useEffect needed)
  const kpi = useMemo<KPI | null>(() => {
    // Чекаємо лише списки, які роль читає; решта показників — `null` («—»).
    if (!enabled) return null;
    if (access.orders && !ordersData) return null;
    if (access.lowStock && !lowStockData) return null;
    if (access.invoices && !invoicesData) return null;
    const today = kyivToday();
    const allOrders: WorkOrderSummary[] =
      (ordersData as { items?: WorkOrderSummary[] } | undefined)?.items ?? [];
    const todayOrders = allOrders.filter(
      // Київська дата завершення, не UTC-зріз ISO-рядка: наряд, закритий о 00:30 за Києвом,
      // в UTC ще «вчора» і в лічильник «завершено сьогодні» не потрапляв (Bug #812).
      // Скасований після завершення наряд зберігає completedAt, але завершеним уже не є.
      o => o.status !== 'CANCELLED' && kyivDateOf(o.completedAt) === today,
    );
    // До сплати — лише залишок: чернетка, повністю віддзеркалена з оплаченого наряду
    // (paidAmount = amount), боргу не має, частково оплачений рахунок — на суму залишку
    // (TECH-DEBT §10 п. 26, як лічильник сервера).
    const allInvoices: InvoiceSummary[] = (
      (invoicesData as { items?: InvoiceSummary[] } | undefined)?.items ?? []
    ).filter(i => (i.paidAmount ?? 0) < i.amount);
    // Списки беруть перші 200 (`limit=200`). Коли сервер має більше (`total`), лічильник і сума з
    // них — лише частина: показувати її як точне число не можна (Bug #987), тож «—».
    const truncated = (d: unknown): boolean => {
      const p = d as { items?: unknown[]; total?: number } | undefined;
      return typeof p?.total === 'number' && p.total > (p.items?.length ?? 0);
    };
    const ordersPartial = truncated(ordersData);
    const invoicesPartial = truncated(invoicesData);
    const pnlTotal = (key: 'revenue' | 'netProfit'): number | null =>
      access.revenue && pnlData ? (pnlData.rows.find(r => r.key === key)?.total ?? 0) : null;
    const lowArr = Array.isArray(lowStockData) ? lowStockData : [];
    return {
      openOrders: access.orders
        ? allOrders.filter(o => WO_EDITABLE_STATUSES.includes(o.status)).length
        : null,
      // Ті самі статуси, що `activeWo` сервера (IN_PROGRESS + ON_HOLD): це запасне значення його
      // ж картки, і при збої підзапиту число не має мінятися від іншого правила (Bug #987).
      inProgressOrders:
        access.orders && !ordersPartial
          ? allOrders.filter(o => WO_IN_WORK_STATUSES.includes(o.status)).length
          : null,
      completedToday: access.orders ? todayOrders.length : null,
      revenueMonth: pnlTotal('revenue'),
      netProfitMonth: pnlTotal('netProfit'),
      payrollMissing: !!pnlData && pnlData.payrollMissingMonths.length > 0,
      lowStockCount: access.lowStock ? lowArr.length : null,
      unpaidInvoices: access.invoices && !invoicesPartial ? allInvoices.length : null,
      unpaidAmount:
        access.invoices && !invoicesPartial
          ? roundMoney(allInvoices.reduce((s, i) => s + i.amount - (i.paidAmount ?? 0), 0))
          : null,
    };
  }, [
    enabled,
    access.orders,
    access.lowStock,
    access.invoices,
    access.revenue,
    ordersData,
    lowStockData,
    invoicesData,
    pnlData,
  ]);

  // Усі 7 днів, порожні — нулем; без даних (запит не прийшов чи впав) — порожньо, не нулі.
  const revenue: RevenueDay[] = useMemo(() => {
    const rows = (revenueData as { rows?: RevenueDay[] } | undefined)?.rows;
    return rows ? fillRevenueWeek(rows, kyivToday()) : (EMPTY_REVENUE as RevenueDay[]);
  }, [revenueData]);
  const upcomingTO: MaintenanceSchedule[] = Array.isArray(maintenanceData)
    ? (maintenanceData as MaintenanceSchedule[])
    : (EMPTY_MAINTENANCE as MaintenanceSchedule[]);
  // sto-optimize: kyivToday() обчислюється раз для всього компонента (mount-stable).
  // Раніше викликалась всередині .map() для upcomingTO → kyivToday() inside hot-path
  // (new Date() + Intl.format() per row). Empty deps — поточна дата на mount достатня
  // для UI на одну page-сесію.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const todayKyiv = useMemo(() => kyivToday(), []);

  useEffect(() => {
    setTodayStr(getFullDateFmt().format(new Date()));
    const h = parseInt(KYIV_HOUR_FMT.format(new Date()), 10);
    setGreeting(
      h < 12 ? t('greeting.morning') : h < 18 ? t('greeting.afternoon') : t('greeting.evening'),
    );
    try {
      const saved = localStorage.getItem(QA_STORAGE_KEY);
      if (saved) setEnabledQA(JSON.parse(saved) as string[]);
    } catch {
      /* ignore */
    }
  }, [t]);

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
    <div className="page-fill page-scroll p-4 md:p-6">
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
        <EmptyState title={t('empty.title')} description={t('empty.description')} />
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
          <div
            className={cn(
              'grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4',
              canViewRevenue ? 'lg:grid-cols-4 2xl:grid-cols-7' : 'lg:grid-cols-6',
            )}
          >
            <Link href={workOrdersStatusHref(WO_IN_WORK_STATUSES)} className="flex">
              <KpiCard
                label={t('kpi.inProgress')}
                value={streamData?.activeWo ?? kpi.inProgressOrders ?? '—'}
                icon={<Wrench />}
                colorClass="kpi-card-blue"
                trend={
                  kpi.completedToday !== null
                    ? {
                        value: t('kpi.completedToday', { n: kpi.completedToday }),
                        // Нуль — нейтрально, без червоної стрілки вниз.
                        up: kpi.completedToday > 0 ? true : undefined,
                      }
                    : undefined
                }
                className="w-full"
              />
            </Link>
            <Link href={workOrdersStatusHref(WO_EDITABLE_STATUSES)} className="flex">
              <KpiCard
                label={t('kpi.open')}
                value={kpi.openOrders ?? '—'}
                icon={<Clock />}
                colorClass="kpi-card-amber"
                className="w-full"
              />
            </Link>
            <Link href="/reports" className="flex">
              <KpiCard
                label={t('kpi.revenueToday')}
                // «Оплати сьогодні» — гроші, що надійшли за день (живий потік). Запасного
                // значення немає свідомо: сума завершених нарядів — інша величина, і під
                // цим підписом вона вводила б в оману. `null` — підзапит сервера не встиг: «—», не 0.
                value={streamData?.todayRevenue != null ? fmt(streamData.todayRevenue) : '—'}
                icon={<TrendingUp />}
                colorClass="kpi-card-green"
                className="w-full"
              />
            </Link>
            <Link href="/reports" className="flex">
              <KpiCard
                label={t('kpi.revenueMonth')}
                value={kpi.revenueMonth !== null ? fmt(kpi.revenueMonth) : '—'}
                icon={<BarChart2 />}
                colorClass="kpi-card-violet"
                className="w-full"
              />
            </Link>
            {canViewRevenue && (
              <Link href="/reports?tab=pnl" className="flex" data-testid="kpi-net-profit-month">
                <KpiCard
                  label={t('kpi.netProfitMonth')}
                  value={kpi.netProfitMonth !== null ? fmt(kpi.netProfitMonth) : '—'}
                  icon={<Wallet />}
                  colorClass={
                    kpi.netProfitMonth !== null && kpi.netProfitMonth < 0
                      ? 'kpi-card-red'
                      : 'kpi-card-green'
                  }
                  trend={
                    kpi.payrollMissing
                      ? { value: t('kpi.payrollNotComputed'), up: false }
                      : undefined
                  }
                  className="w-full"
                />
              </Link>
            )}
            <Link href="/invoices" className="flex">
              <KpiCard
                label={t('kpi.unpaidInvoices')}
                value={streamData?.pendingInvoices ?? kpi.unpaidInvoices ?? '—'}
                icon={<FileX />}
                colorClass={
                  (streamData?.pendingInvoices ?? kpi.unpaidInvoices ?? 0) > 0
                    ? 'kpi-card-red'
                    : 'kpi-card-blue'
                }
                trend={
                  kpi.unpaidAmount !== null && kpi.unpaidAmount > 0
                    ? { value: fmt(kpi.unpaidAmount), up: false }
                    : undefined
                }
                className="w-full"
              />
            </Link>
            <Link href="/reports?tab=inventory" className="flex">
              <KpiCard
                label={t('kpi.lowStock')}
                value={streamData?.lowStockCount ?? kpi.lowStockCount ?? '—'}
                icon={<AlertTriangle />}
                colorClass={
                  (streamData?.lowStockCount ?? kpi.lowStockCount ?? 0) > 0
                    ? 'kpi-card-amber'
                    : 'kpi-card-teal'
                }
                className="w-full"
              />
            </Link>
          </div>

          {/* Revenue chart — лише для ролей з доступом до фін-звітності (RBAC /reports/revenue) */}
          {canViewRevenue && revenue.length > 0 ? (
            <Card className="mb-4">
              <CardHeader className="px-4 pt-3 pb-2.5">
                <div className="flex items-center justify-between">
                  <CardTitle>{t('revenue.title')}</CardTitle>
                  <Link
                    href="/reports"
                    className="text-[12px] text-primary hover:underline font-medium"
                  >
                    {t('revenue.allReports')}
                  </Link>
                </div>
              </CardHeader>
              <CardContent className="px-4 py-3">
                <RevenueChart data={revenue} />
              </CardContent>
            </Card>
          ) : null}

          {/* Upcoming maintenance ТО */}
          {upcomingTO.length > 0 && (
            <Card className="mb-4">
              <CardHeader className="px-4 pt-3 pb-2.5">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <CalendarClock className="h-4 w-4 text-warning" />
                    {t('maintenance.title', { n: upcomingTO.length })}
                  </CardTitle>
                  <Link
                    href="/counterparties"
                    className="text-[12px] text-primary hover:underline font-medium"
                  >
                    {t('maintenance.allClients')}
                  </Link>
                </div>
              </CardHeader>
              <CardContent className="px-4 py-3">
                <div className="divide-y divide-border">
                  {upcomingTO.slice(0, 8).map(item => {
                    const dateStr = item.nextMaintenanceDate
                      ? fmtDate(item.nextMaintenanceDate)
                      : null;
                    // Logic-bug fix: попередня перевірка `new Date(YMD).getTime() < nowMs`
                    // інтерпретувала "2026-06-15" як 00:00 UTC = 03:00 Kyiv → ТО на сьогодні
                    // показувалось "Прострочено" вже з 03:00 ночі. Порівнюємо дату-string зі
                    // string-датою «сьогодні у Києві» (todayKyiv через useMemo вище).
                    const isOverdue = item.nextMaintenanceDate
                      ? item.nextMaintenanceDate.slice(0, 10) < todayKyiv
                      : false;
                    return (
                      <div key={item.id} className="flex items-center justify-between py-2">
                        <div>
                          <p className="text-[13px] font-medium text-foreground">
                            {item.vehicleLabel ?? item.vehicleId}
                          </p>
                          <p className="text-[12px] text-muted-foreground">
                            {item.maintenanceType === 'REGULAR'
                              ? t('maintenance.regular')
                              : item.maintenanceType === 'SEASONAL'
                                ? t('maintenance.seasonal')
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
                            {isOverdue ? t('maintenance.overdue') : dateStr}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Календар — підсумки поточного місяця (BR-CAL-013); ролям без календаря картки немає */}
          {access.calendar && (
            <Card className="mb-4" data-testid="dashboard-calendar-summary">
              <CardHeader className="px-4 pt-3 pb-2.5">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <CalendarDays className="h-4 w-4 text-primary" />
                    {t('calendar.title', { month: fmtKyivMonthYear(`${calendarMonth}-01`) })}
                  </CardTitle>
                  <Link
                    href="/calendar/?view=month"
                    className="text-[12px] text-primary hover:underline font-medium"
                  >
                    {t('calendar.open')}
                  </Link>
                </div>
              </CardHeader>
              <CardContent className="px-4 py-3">
                {monthSummary.loading ? (
                  <PageSpinner />
                ) : monthSummary.error ? (
                  <p className="text-sm text-destructive-text">{t('calendar.loadError')}</p>
                ) : (
                  <CalendarMonthSummary
                    yearMonth={calendarMonth}
                    monthSlots={monthSummary.monthSlots}
                    lifts={monthSummary.lifts}
                    tasks={monthSummary.tasks}
                    windowStart={monthSummary.windowStart}
                    windowEnd={monthSummary.windowEnd}
                    nowMs={monthSummary.nowMs}
                  />
                )}
              </CardContent>
            </Card>
          )}

          {/* Quick actions */}
          <Card>
            <CardHeader className="px-4 pt-3 pb-2.5">
              <div className="flex items-center justify-between">
                <CardTitle>{t('quickActionsCard.title')}</CardTitle>
                <button
                  onClick={() => setQaConfigOpen(o => !o)}
                  className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                  title={t('quickActionsCard.configure')}
                >
                  <Settings2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </CardHeader>
            <CardContent className="px-4 py-3">
              {qaConfigOpen && (
                <div className="mb-4 p-3 bg-secondary rounded-lg border border-border">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    {t('quickActionsCard.chooseActions')}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {ALL_QUICK_ACTIONS.map(({ href, labelKey, icon: Icon }) => {
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
                          {t(`quickActions.${labelKey}`)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap gap-2.5">
                {ALL_QUICK_ACTIONS.filter(a => enabledQA.includes(a.href)).map(
                  ({ href, to, labelKey, icon: Icon }) => (
                    <Link
                      key={href}
                      href={to ?? href}
                      className="inline-flex items-center gap-1.5 h-8 px-3 text-[13px] font-medium rounded-lg border border-border bg-surface text-foreground hover:bg-secondary hover:border-border-hover transition-all duration-150"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t(`quickActions.${labelKey}`)}
                    </Link>
                  ),
                )}
                {enabledQA.length === 0 && (
                  <p className="text-[13px] text-muted-foreground">{t('quickActionsCard.empty')}</p>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
