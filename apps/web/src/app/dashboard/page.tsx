'use client';

import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import Link from 'next/link';
import {
  Wrench, Clock, TrendingUp, AlertTriangle, FileX, BarChart2,
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

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

interface KpiCardProps {
  label: string;
  value: string | number;
  sub?: string;
  valueClass?: string;
  href?: string;
  icon: React.ElementType;
  iconClass?: string;
}

function KpiCard({ label, value, sub, valueClass, href, icon: Icon, iconClass }: KpiCardProps) {
  const inner = (
    <Card hoverable={!!href}>
      <CardContent className="pt-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
            <p className={['text-2xl font-bold mt-1 tabular-nums', valueClass ?? 'text-gray-900'].join(' ')}>
              {value}
            </p>
            {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
          </div>
          <div className={['flex h-9 w-9 items-center justify-center rounded-lg shrink-0', iconClass ?? 'bg-gray-100'].join(' ')}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

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
        const todayOrders = allOrders.filter(o =>
          o.completedAt && o.completedAt.slice(0, 10) === today);

        const allInvoices: InvoiceSummary[] = invoicesData.items ?? [];
        const unpaidAmount = allInvoices.reduce((s, i) => s + i.amount, 0);

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
          unpaidAmount,
        });

        setRevenue(revData.rows ?? []);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Помилка завантаження дашборду');
      } finally { setLoading(false); }
    };

    loadData();
  }, []);

  if (!employee) return null;

  const greeting = () => {
    const h = parseInt(
      new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: 'numeric', hour12: false }).format(new Date()),
      10,
    );
    if (h < 12) return 'Доброго ранку';
    if (h < 18) return 'Доброго дня';
    return 'Доброго вечора';
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">
          {greeting()}, {employee.firstName}!
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          {new Date().toLocaleDateString('uk-UA', {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
          })}
        </p>
      </div>

      {loading ? (
        <div className="text-center py-20 text-gray-400 text-sm">Завантаження даних...</div>
      ) : kpi && (
        <>
          {/* KPI grid — row 1 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <KpiCard
              label="В роботі"
              value={kpi.inProgressOrders}
              sub="нарядів зараз"
              valueClass="text-blue-600"
              href="/work-orders"
              icon={Wrench}
              iconClass="bg-blue-100 text-blue-600"
            />
            <KpiCard
              label="Очікують"
              value={kpi.openOrders}
              sub="нарядів на прийом"
              valueClass="text-amber-600"
              href="/work-orders"
              icon={Clock}
              iconClass="bg-amber-100 text-amber-600"
            />
            <KpiCard
              label="Виручка сьогодні"
              value={fmt(kpi.revenueToday)}
              sub={`${kpi.completedToday} нарядів завершено`}
              valueClass="text-green-700"
              href="/reports"
              icon={TrendingUp}
              iconClass="bg-green-100 text-green-700"
            />
            <KpiCard
              label="Виручка за місяць"
              value={fmt(kpi.revenueMonth)}
              href="/reports"
              icon={BarChart2}
              iconClass="bg-gray-100 text-gray-600"
            />
          </div>

          {/* KPI grid — row 2 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <KpiCard
              label="Несплачені рахунки"
              value={kpi.unpaidInvoices}
              sub={kpi.unpaidAmount > 0 ? fmt(kpi.unpaidAmount) : undefined}
              valueClass={kpi.unpaidInvoices > 0 ? 'text-red-600' : 'text-gray-500'}
              href="/invoices"
              icon={FileX}
              iconClass={kpi.unpaidInvoices > 0 ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-400'}
            />
            <KpiCard
              label="Низький залишок"
              value={kpi.lowStockCount}
              sub="позицій на складі"
              valueClass={kpi.lowStockCount > 0 ? 'text-amber-600' : 'text-gray-500'}
              href="/inventory"
              icon={AlertTriangle}
              iconClass={kpi.lowStockCount > 0 ? 'bg-amber-100 text-amber-600' : 'bg-gray-100 text-gray-400'}
            />
          </div>

          {/* Revenue chart */}
          {revenue.length > 0 && (
            <Card className="mb-6">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Виручка за 7 днів</CardTitle>
                  <Link href="/reports" className="text-xs text-blue-600 hover:text-blue-800 font-medium">
                    Всі звіти →
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={revenue}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 11 }}
                      tickFormatter={d =>
                        new Date(d + 'T00:00').toLocaleDateString('uk-UA', {
                          day: 'numeric', month: 'short',
                        })
                      }
                    />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      tickFormatter={v => (v / 1000).toFixed(0) + 'к'}
                    />
                    <Tooltip
                      formatter={(v) => [fmt(Number(v ?? 0)), 'Виручка']}
                      labelFormatter={d => new Date(d + 'T00:00').toLocaleDateString('uk-UA')}
                    />
                    <Bar dataKey="revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {/* Quick actions */}
          <Card>
            <CardHeader>
              <CardTitle>Швидкі дії</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-3">
                <Link
                  href="/work-orders"
                  className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
                >
                  + Новий наряд
                </Link>
                <Link
                  href="/crm"
                  className="px-4 py-2 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
                >
                  + Новий клієнт
                </Link>
                <Link
                  href="/purchase-orders"
                  className="px-4 py-2 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
                >
                  + Замовлення постачальнику
                </Link>
                <Link
                  href="/invoices"
                  className="px-4 py-2 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
                >
                  + Рахунок
                </Link>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
