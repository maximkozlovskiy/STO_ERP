'use client';

import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import Link from 'next/link';
import {
  Wrench, Clock, TrendingUp, AlertTriangle, FileX, BarChart2,
  Plus, Users, ShoppingCart, Receipt,
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { KpiCard, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageSpinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';

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

interface RevenueDay { date: string; revenue: number; count: number; }
interface WorkOrderSummary { status: string; completedAt?: string | null; totalAmount: number; }
interface InvoiceSummary { amount: number; }
interface PaginatedWorkOrders { items: WorkOrderSummary[]; }
interface PaginatedInvoices { items: InvoiceSummary[]; }
interface RevenueReport { rows: RevenueDay[]; totalRevenue: number; }

function fmt(n: number) {
  return n.toLocaleString('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' ₴';
}

const QUICK_ACTIONS = [
  { href: '/work-orders', label: 'Новий наряд',             icon: Wrench },
  { href: '/crm',         label: 'Новий клієнт',            icon: Users },
  { href: '/purchase-orders', label: 'Замовлення',          icon: ShoppingCart },
  { href: '/invoices',    label: 'Рахунок',                  icon: Receipt },
];

export default function DashboardPage() {
  const { employee } = useRequireAuth();
  const [kpi, setKpi] = useState<KPI | null>(null);
  const [revenue, setRevenue] = useState<RevenueDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const kyivDate = (d: Date) =>
          new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(d);
        const today = kyivDate(new Date());
        const now = new Date();
        const kyivStr = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(now);
        const [kyivYear, kyivMonth] = kyivStr.split('-').map(Number);
        const monthStart = `${kyivYear}-${String(kyivMonth).padStart(2, '0')}-01`;
        const weekStart = kyivDate(new Date(Date.now() - 6 * 86_400_000));

        const [orders, lowStock, invoices, revenueData] = await Promise.allSettled([
          apiFetch<PaginatedWorkOrders>('/work-orders?limit=200'),
          apiFetch<WorkOrderSummary[]>('/stock-items/low'),
          apiFetch<PaginatedInvoices>('/invoices?status=SENT&limit=200'),
          apiFetch<RevenueReport>(`/reports/revenue?from=${weekStart}&to=${today}`),
        ]);

        const ordersData = orders.status === 'fulfilled' ? orders.value : { items: [] };
        const lowStockData = lowStock.status === 'fulfilled' ? lowStock.value : [];
        const invoicesData = invoices.status === 'fulfilled' ? invoices.value : { items: [] };
        const revData = revenueData.status === 'fulfilled' ? revenueData.value : { rows: [], totalRevenue: 0 };

        const allOrders: WorkOrderSummary[] = ordersData.items ?? [];
        const todayOrders = allOrders.filter(o => o.completedAt && o.completedAt.slice(0, 10) === today);
        const allInvoices: InvoiceSummary[] = invoicesData.items ?? [];
        const monthRevenue = (revData.rows as RevenueDay[])
          .filter(r => r.date >= monthStart)
          .reduce((s, r) => s + r.revenue, 0);

        setKpi({
          openOrders: allOrders.filter(o => ['DRAFT', 'ESTIMATE', 'APPROVED'].includes(o.status)).length,
          inProgressOrders: allOrders.filter(o => o.status === 'IN_PROGRESS').length,
          completedToday: todayOrders.length,
          revenueToday: todayOrders.reduce((s, o) => s + o.totalAmount, 0),
          revenueMonth: monthRevenue,
          lowStockCount: Array.isArray(lowStockData) ? lowStockData.length : 0,
          unpaidInvoices: allInvoices.length,
          unpaidAmount: allInvoices.reduce((s, i) => s + i.amount, 0),
        });

        setRevenue(revData.rows ?? []);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Помилка завантаження дашборду');
      } finally { setLoading(false); }
    };

    loadData();
  }, []);

  if (!employee) return null;

  const hour = parseInt(
    new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: 'numeric', hour12: false }).format(new Date()), 10,
  );
  const greeting = hour < 12 ? 'Доброго ранку' : hour < 18 ? 'Доброго дня' : 'Доброго вечора';

  return (
    <div className="page-container">
      {error && (
        <div className="mb-4 text-[13px] text-[hsl(0_84%_42%)] bg-(--color-destructive-subtle) border border-[hsl(0_84%_80%)] rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}

      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">{greeting}, {employee.firstName}!</h1>
          <p className="page-subtitle">
            {new Date().toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>
      </div>

      {loading ? (
        <PageSpinner />
      ) : !kpi ? (
        <EmptyState title="Немає даних" description="Не вдалося завантажити показники" />
      ) : (
        <>
          {/* KPI row 1 */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <Link href="/work-orders">
              <KpiCard
                label="В роботі"
                value={kpi.inProgressOrders}
                icon={<Wrench />}
                colorClass="kpi-card-blue"
                trend={{ value: `${kpi.completedToday} завершено сьогодні`, up: kpi.completedToday > 0 }}
              />
            </Link>
            <Link href="/work-orders">
              <KpiCard
                label="Очікують"
                value={kpi.openOrders}
                icon={<Clock />}
                colorClass="kpi-card-amber"
              />
            </Link>
            <Link href="/reports">
              <KpiCard
                label="Виручка сьогодні"
                value={fmt(kpi.revenueToday)}
                icon={<TrendingUp />}
                colorClass="kpi-card-green"
              />
            </Link>
            <Link href="/reports">
              <KpiCard
                label="Виручка за місяць"
                value={fmt(kpi.revenueMonth)}
                icon={<BarChart2 />}
                colorClass="kpi-card-violet"
              />
            </Link>
          </div>

          {/* KPI row 2 */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <Link href="/invoices">
              <KpiCard
                label="Несплачені рахунки"
                value={kpi.unpaidInvoices}
                icon={<FileX />}
                colorClass={kpi.unpaidInvoices > 0 ? 'kpi-card-red' : 'kpi-card-blue'}
                trend={kpi.unpaidAmount > 0 ? { value: fmt(kpi.unpaidAmount), up: false } : undefined}
              />
            </Link>
            <Link href="/inventory">
              <KpiCard
                label="Низький залишок"
                value={kpi.lowStockCount}
                icon={<AlertTriangle />}
                colorClass={kpi.lowStockCount > 0 ? 'kpi-card-amber' : 'kpi-card-teal'}
              />
            </Link>
          </div>

          {/* Revenue chart */}
          {revenue.length > 0 ? (
            <Card className="mb-6">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Виручка за 7 днів</CardTitle>
                  <Link href="/reports" className="text-[12px] text-(--color-primary) hover:underline font-medium">
                    Всі звіти →
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={revenue} margin={{ left: -10 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(214 32% 91%)" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 11, fill: 'hsl(215 16% 55%)' }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={d =>
                        new Date(d + 'T00:00').toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })
                      }
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: 'hsl(215 16% 55%)' }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={v => (v / 1000).toFixed(0) + 'к'}
                    />
                    <Tooltip
                      cursor={{ fill: 'hsl(214 95% 97%)' }}
                      contentStyle={{
                        borderRadius: 8, border: '1px solid hsl(214 32% 91%)',
                        fontSize: 12, boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                      }}
                      formatter={(v) => [fmt(Number(v ?? 0)), 'Виручка']}
                      labelFormatter={d => new Date(d + 'T00:00').toLocaleDateString('uk-UA')}
                    />
                    <Bar dataKey="revenue" fill="hsl(221 83% 53%)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          ) : null}

          {/* Quick actions */}
          <Card>
            <CardHeader>
              <CardTitle>Швидкі дії</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2.5">
                {QUICK_ACTIONS.map(({ href, label, icon: Icon }) => (
                  <Link
                    key={href}
                    href={href}
                    className="inline-flex items-center gap-1.5 h-8 px-3 text-[13px] font-medium rounded-(--radius) border border-(--color-border) bg-white text-foreground hover:bg-(--color-secondary) hover:border-border-hover transition-all duration-150"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {label}
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
