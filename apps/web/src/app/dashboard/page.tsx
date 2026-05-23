'use client';

import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import Link from 'next/link';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

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

function KpiCard({ label, value, sub, color, href }: {
  label: string; value: string | number; sub?: string;
  color?: string; href?: string;
}) {
  const content = (
    <div className={`bg-white rounded-xl border border-gray-200 p-5 ${href ? 'hover:border-blue-300 transition-colors cursor-pointer' : ''}`}>
      <div className="text-xs font-medium text-gray-400 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${color ?? 'text-gray-900'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
  return href ? <Link href={href}>{content}</Link> : content;
}

function fmt(n: number) {
  return n.toLocaleString('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' ₴';
}

export default function DashboardPage() {
  const { employee } = useRequireAuth();
  const [kpi, setKpi] = useState<KPI | null>(null);
  const [revenue, setRevenue] = useState<RevenueDay[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const today = new Date().toISOString().slice(0, 10);
        const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
        const weekStart = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);

        const [orders, lowStock, invoices, revenueData] = await Promise.allSettled([
          apiFetch('/work-orders?limit=200'),
          apiFetch('/stock-items/low'),
          apiFetch('/invoices?status=SENT&limit=200'),
          apiFetch(`/reports/revenue?from=${weekStart}&to=${today}`),
        ]);

        const ordersData = orders.status === 'fulfilled' ? orders.value : { items: [] };
        const lowStockData = lowStock.status === 'fulfilled' ? lowStock.value : [];
        const invoicesData = invoices.status === 'fulfilled' ? invoices.value : { items: [] };
        const revData = revenueData.status === 'fulfilled' ? revenueData.value : { rows: [], totalRevenue: 0 };

        const allOrders = ordersData.items ?? [];
        const todayOrders = allOrders.filter((o: any) =>
          o.completedAt && o.completedAt.slice(0, 10) === today);

        const allInvoices = invoicesData.items ?? [];
        const unpaidAmount = allInvoices.reduce((s: number, i: any) => s + i.amount, 0);

        const monthRevenue = revData.rows
          .filter((r: any) => r.date >= monthStart)
          .reduce((s: number, r: any) => s + r.revenue, 0);

        setKpi({
          openOrders: allOrders.filter((o: any) => ['DRAFT', 'ESTIMATE', 'APPROVED'].includes(o.status)).length,
          inProgressOrders: allOrders.filter((o: any) => o.status === 'IN_PROGRESS').length,
          completedToday: todayOrders.length,
          revenueToday: todayOrders.reduce((s: number, o: any) => s + o.totalAmount, 0),
          revenueMonth: monthRevenue,
          lowStockCount: Array.isArray(lowStockData) ? lowStockData.length : 0,
          unpaidInvoices: allInvoices.length,
          unpaidAmount,
        });

        setRevenue(revData.rows ?? []);
      } finally { setLoading(false); }
    };

    loadData();
  }, []);

  if (!employee) return null;

  const greeting = () => {
    const h = new Date().getHours();
    if (h < 12) return 'Доброго ранку';
    if (h < 18) return 'Доброго дня';
    return 'Доброго вечора';
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          {greeting()}, {employee.firstName}!
        </h1>
        <p className="text-gray-400 text-sm mt-0.5">
          {new Date().toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        </p>
      </div>

      {loading ? (
        <div className="text-center py-20 text-gray-400">Завантаження даних...</div>
      ) : kpi && (
        <>
          {/* KPI grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <KpiCard label="В роботі" value={kpi.inProgressOrders} sub="нарядів зараз"
              color="text-blue-600" href="/work-orders" />
            <KpiCard label="Очікують" value={kpi.openOrders} sub="нарядів на прийом"
              color="text-amber-600" href="/work-orders" />
            <KpiCard label="Виручка сьогодні" value={fmt(kpi.revenueToday)} sub={`${kpi.completedToday} нарядів завершено`}
              color="text-green-700" href="/reports" />
            <KpiCard label="Виручка за місяць" value={fmt(kpi.revenueMonth)}
              color="text-gray-900" href="/reports" />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <KpiCard label="Несплачені рахунки" value={kpi.unpaidInvoices}
              sub={kpi.unpaidAmount > 0 ? fmt(kpi.unpaidAmount) : undefined}
              color={kpi.unpaidInvoices > 0 ? 'text-red-600' : 'text-gray-500'}
              href="/invoices" />
            <KpiCard label="Низький залишок" value={kpi.lowStockCount} sub="позицій на складі"
              color={kpi.lowStockCount > 0 ? 'text-amber-600' : 'text-gray-500'}
              href="/inventory" />
          </div>

          {/* Revenue chart */}
          {revenue.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold text-gray-900">Виручка за 7 днів</h2>
                <Link href="/reports" className="text-xs text-blue-600 hover:text-blue-800 font-medium">
                  Всі звіти →
                </Link>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={revenue}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }}
                    tickFormatter={d => new Date(d + 'T00:00').toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={v => (v / 1000).toFixed(0) + 'к'} />
                  <Tooltip
                    formatter={(v: number) => [fmt(v), 'Виручка']}
                    labelFormatter={d => new Date(d + 'T00:00').toLocaleDateString('uk-UA')} />
                  <Bar dataKey="revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Quick actions */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="font-semibold text-gray-900 mb-4">Швидкі дії</h2>
            <div className="flex flex-wrap gap-3">
              <Link href="/work-orders"
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors">
                + Новий наряд
              </Link>
              <Link href="/crm"
                className="px-4 py-2 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">
                + Новий клієнт
              </Link>
              <Link href="/purchase-orders"
                className="px-4 py-2 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">
                + Замовлення постачальнику
              </Link>
              <Link href="/invoices"
                className="px-4 py-2 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">
                + Рахунок
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
