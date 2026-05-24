'use client';

import { useState, useCallback } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, Legend,
} from 'recharts';

type Tab = 'revenue' | 'work-orders' | 'stock' | 'settlements' | 'load';

type RevenueRow = { date: string; revenue: number; labor: number; parts: number; count: number };
type WorkOrderRow = { employeeId: string; employeeName: string; totalNormoHours: number; linesCount: number; totalAmount: number };
type StockItem = { goodName: string; goodSku: string | null; warehouseName: string; unit: string; quantity: number; available: number; value: number };
type SettlementRow = { counterpartyId: string; counterpartyName: string; balance: number };
type LoadRow = { liftId: string; liftName: string; zoneName: string; totalSlots: number; totalHours: number; loadPercent: number };

type ReportData =
  | { _tab: 'revenue'; totalRevenue: number; totalOrders: number; rows: RevenueRow[] }
  | { _tab: 'work-orders'; totalNormoHours: number; totalAmount: number; rows: WorkOrderRow[] }
  | { _tab: 'stock'; totalValue: number; stockItems: StockItem[] }
  | { _tab: 'settlements'; totalDebit: number; totalCredit: number; rows: SettlementRow[] }
  | { _tab: 'load'; rows: LoadRow[] };

function fmt(n: number) {
  return n.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₴';
}

function fmtNum(n: number, dec = 1) {
  return n.toLocaleString('uk-UA', { maximumFractionDigits: dec });
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="text-sm text-gray-500">{label}</div>
      <div className="text-2xl font-bold text-gray-900 mt-1">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

export default function ReportsPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT']);

  const [tab, setTab] = useState<Tab>('revenue');
  const [from, setFrom] = useState(new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setData(null);
    setError('');
    try {
      const params = new URLSearchParams({ from, to });
      const result = await apiFetch<Record<string, unknown>>(`/reports/${tab}?${params}`);
      setData({ ...result, _tab: tab } as ReportData);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження звіту');
    } finally { setLoading(false); }
  }, [tab, from, to]);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'revenue', label: 'Виручка' },
    { id: 'work-orders', label: 'Наряди' },
    { id: 'stock', label: 'Залишки' },
    { id: 'settlements', label: 'Розрахунки' },
    { id: 'load', label: 'Завантаженість' },
  ];

  const needsDates = ['revenue', 'work-orders', 'load'].includes(tab);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {error && <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>}
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Звіти</h1>

      {/* Tabs */}
      <div className="flex gap-1 border-b mb-6">
        {tabs.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setData(null); }}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6 items-end">
        {needsDates && (
          <>
            <div>
              <label className="block text-xs text-gray-500 mb-1">З</label>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">По</label>
              <input type="date" value={to} onChange={e => setTo(e.target.value)}
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
          </>
        )}
        <button onClick={load} disabled={loading}
          className="px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
          {loading ? 'Завантаження...' : 'Сформувати'}
        </button>
        {data && (
          <button onClick={() => {
            const csv = buildCsv(tab, data);
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = `${tab}-report.csv`; a.click();
          }} className="px-4 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 transition-colors">
            Експорт CSV
          </button>
        )}
      </div>

      {!data && !loading && (
        <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
          Оберіть параметри і натисніть «Сформувати»
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center h-64 text-gray-400 text-sm">Завантаження...</div>
      )}

      {/* Revenue report */}
      {data && data._tab === 'revenue' && (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-4">
            <Card label="Загальна виручка" value={fmt(data.totalRevenue)} />
            <Card label="Кількість нарядів" value={String(data.totalOrders)} />
            <Card label="Середній чек" value={data.totalOrders > 0 ? fmt(data.totalRevenue / data.totalOrders) : '—'} />
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="font-medium text-gray-900 mb-4">Виручка по днях</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.rows}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={v => (v / 1000).toFixed(0) + 'к'} />
                <Tooltip formatter={(v: number) => fmt(v)} />
                <Bar dataKey="revenue" fill="#3b82f6" name="Виручка" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="font-medium text-gray-900 mb-4">Роботи vs Запчастини</h3>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={data.rows}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => fmt(v)} />
                <Line type="monotone" dataKey="labor" stroke="#10b981" name="Роботи" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="parts" stroke="#f59e0b" name="Запчастини" dot={false} strokeWidth={2} />
                <Legend />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Work orders report */}
      {data && data._tab === 'work-orders' && (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-4">
            <Card label="Всього норм-годин" value={fmtNum(data.totalNormoHours)} />
            <Card label="Сума робіт" value={fmt(data.totalAmount)} />
            <Card label="Механіків" value={String(data.rows.length)} />
          </div>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 text-gray-500 font-medium">Механік</th>
                  <th className="text-right px-4 py-3 text-gray-500 font-medium">Норм-год</th>
                  <th className="text-right px-4 py-3 text-gray-500 font-medium">Позицій</th>
                  <th className="text-right px-4 py-3 text-gray-500 font-medium">Сума</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.rows.map((r) => (
                  <tr key={r.employeeId} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{r.employeeName}</td>
                    <td className="px-4 py-3 text-right">{fmtNum(r.totalNormoHours)}</td>
                    <td className="px-4 py-3 text-right text-gray-500">{r.linesCount}</td>
                    <td className="px-4 py-3 text-right font-semibold">{fmt(r.totalAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Stock report */}
      {data && data._tab === 'stock' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <Card label="Позицій на складах" value={String(data.stockItems.length)} />
            <Card label="Загальна вартість" value={fmt(data.totalValue)} />
          </div>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 text-gray-500 font-medium">Товар</th>
                  <th className="text-left px-4 py-3 text-gray-500 font-medium">Склад</th>
                  <th className="text-right px-4 py-3 text-gray-500 font-medium">Кількість</th>
                  <th className="text-right px-4 py-3 text-gray-500 font-medium">Доступно</th>
                  <th className="text-right px-4 py-3 text-gray-500 font-medium">Вартість</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.stockItems.map((i, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{i.goodName}</div>
                      <div className="text-xs text-gray-400 font-mono">{i.goodSku ?? '—'}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{i.warehouseName}</td>
                    <td className="px-4 py-3 text-right">{fmtNum(i.quantity)} {i.unit}</td>
                    <td className={`px-4 py-3 text-right font-medium ${i.available <= 0 ? 'text-red-600' : 'text-green-700'}`}>
                      {fmtNum(i.available)}
                    </td>
                    <td className="px-4 py-3 text-right">{fmt(i.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Settlements report */}
      {data && data._tab === 'settlements' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <Card label="Дебіторська заборгованість" value={fmt(data.totalDebit)} sub="Клієнти нам" />
            <Card label="Кредиторська заборгованість" value={fmt(data.totalCredit)} sub="Ми постачальникам" />
          </div>
          <div className="grid grid-cols-2 gap-6">
            <div className="bg-white rounded-xl border p-5">
              <h3 className="font-medium text-gray-900 mb-4">Структура</h3>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={[
                    { name: 'Дебіторська', value: data.totalDebit },
                    { name: 'Кредиторська', value: data.totalCredit },
                  ]} cx="50%" cy="50%" outerRadius={80} dataKey="value">
                    <Cell fill="#3b82f6" />
                    <Cell fill="#ef4444" />
                  </Pie>
                  <Tooltip formatter={(v: number) => fmt(v)} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-4 py-3 text-gray-500 font-medium">Контрагент</th>
                    <th className="text-right px-4 py-3 text-gray-500 font-medium">Баланс</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.rows.filter((r) => r.balance !== 0).map((r) => (
                    <tr key={r.counterpartyId} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-900">{r.counterpartyName}</td>
                      <td className={`px-4 py-3 text-right font-semibold ${r.balance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                        {r.balance > 0 ? '+' : ''}{fmt(r.balance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Load report */}
      {data && data._tab === 'load' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="font-medium text-gray-900 mb-4">Завантаженість підйомників (%)</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.rows} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" domain={[0, 100]} tickFormatter={v => v + '%'} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="liftName" tick={{ fontSize: 11 }} width={120} />
                <Tooltip formatter={(v: number) => v + '%'} />
                <Bar dataKey="loadPercent" fill="#3b82f6" radius={[0, 4, 4, 0]} name="Завантаженість">
                  {data.rows.map((_, idx: number) => (
                    <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 text-gray-500 font-medium">Підйомник</th>
                  <th className="text-left px-4 py-3 text-gray-500 font-medium">Зона</th>
                  <th className="text-right px-4 py-3 text-gray-500 font-medium">Слотів</th>
                  <th className="text-right px-4 py-3 text-gray-500 font-medium">Годин</th>
                  <th className="text-right px-4 py-3 text-gray-500 font-medium">Завантаженість</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.rows.map((r) => (
                  <tr key={r.liftId} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{r.liftName}</td>
                    <td className="px-4 py-3 text-gray-500">{r.zoneName}</td>
                    <td className="px-4 py-3 text-right">{r.totalSlots}</td>
                    <td className="px-4 py-3 text-right">{fmtNum(r.totalHours)}г</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-24 bg-gray-100 rounded-full h-2">
                          <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${Math.min(r.loadPercent, 100)}%` }} />
                        </div>
                        <span className={`text-xs font-medium ${r.loadPercent >= 80 ? 'text-red-600' : r.loadPercent >= 50 ? 'text-amber-600' : 'text-green-600'}`}>
                          {r.loadPercent}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function buildCsv(tab: Tab, data: ReportData): string {
  if (tab === 'revenue' && data._tab === 'revenue') {
    const rows = [['Дата', 'Виручка', 'Роботи', 'Запчастини', 'Нарядів'], ...data.rows.map(r => [r.date, r.revenue, r.labor, r.parts, r.count])];
    return rows.map(r => r.join(';')).join('\n');
  }
  if (tab === 'work-orders' && data._tab === 'work-orders') {
    const rows = [['Механік', 'Норм-год', 'Позицій', 'Сума'], ...data.rows.map(r => [r.employeeName, r.totalNormoHours, r.linesCount, r.totalAmount])];
    return rows.map(r => r.join(';')).join('\n');
  }
  if (tab === 'stock' && data._tab === 'stock') {
    const rows = [['Товар', 'Склад', 'Кількість', 'Доступно', 'Вартість'], ...data.stockItems.map(i => [i.goodName, i.warehouseName, i.quantity, i.available, i.value])];
    return rows.map(r => r.join(';')).join('\n');
  }
  if (tab === 'settlements' && data._tab === 'settlements') {
    const rows = [['Контрагент', 'Баланс'], ...data.rows.map(r => [r.counterpartyName, r.balance])];
    return rows.map(r => r.join(';')).join('\n');
  }
  if (tab === 'load' && data._tab === 'load') {
    const rows = [['Підйомник', 'Зона', 'Слотів', 'Годин', 'Завантаженість%'], ...data.rows.map(r => [r.liftName, r.zoneName, r.totalSlots, r.totalHours.toFixed(1), r.loadPercent])];
    return rows.map(r => r.join(';')).join('\n');
  }
  return '';
}
