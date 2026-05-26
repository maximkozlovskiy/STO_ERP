'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, Legend,
} from 'recharts';

type Tab = 'revenue' | 'work-orders' | 'stock' | 'settlements' | 'load' | 'profitability';

type RevenueRow = { date: string; revenue: number; labor: number; parts: number; count: number };
type WorkOrderRow = { employeeId: string; employeeName: string; totalNormoHours: number; linesCount: number; totalAmount: number };
type StockItem = { goodName: string; goodSku: string | null; warehouseName: string; unit: string; quantity: number; available: number; value: number };
type SettlementRow = { counterpartyId: string; counterpartyName: string; balance: number };
type LoadRow = { liftId: string; liftName: string; zoneName: string; totalSlots: number; totalHours: number; loadPercent: number };

type ProfitabilityData = { totalRevenue: number; totalCost: number; totalCostParts: number; totalCostLabor: number; grossProfit: number; margin: number; ordersCount: number };

type ReportData =
  | { _tab: 'revenue'; totalRevenue: number; totalOrders: number; rows: RevenueRow[] }
  | { _tab: 'work-orders'; totalNormoHours: number; totalAmount: number; rows: WorkOrderRow[] }
  | { _tab: 'stock'; totalValue: number; stockItems: StockItem[] }
  | { _tab: 'settlements'; totalDebit: number; totalCredit: number; rows: SettlementRow[] }
  | { _tab: 'load'; rows: LoadRow[] }
  | ({ _tab: 'profitability' } & ProfitabilityData);

function fmt(n: number) {
  return n.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₴';
}

function fmtNum(n: number, dec = 1) {
  return n.toLocaleString('uk-UA', { maximumFractionDigits: dec });
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-surface rounded-xl border border-border p-5">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold text-foreground mt-1">{value}</div>
      {sub && <div className="text-[12px] text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

export default function ReportsPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT']);

  const [tab, setTab] = useState<Tab>('revenue');
  const kyivDate = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(d);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const now = new Date();
    const kyivNow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    setFrom(`${kyivNow.slice(0, 4)}-01-01`);
    setTo(kyivDate(now));
  }, []);

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
    { id: 'profitability', label: 'Рентабельність' },
  ];

  const needsDates = ['revenue', 'work-orders', 'load', 'stock', 'profitability'].includes(tab);

  return (
    <div className="page-container">
      {error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">{error}</div>
      )}
      <h1 className="page-title mb-6">Звіти</h1>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border mb-6">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => { setTab(t.id); setData(null); }}
            className={cn(
              'px-4 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors',
              tab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6 items-end">
        {needsDates && (
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
        <Button onClick={load} loading={loading}>
          Сформувати
        </Button>
        {data && (
          <Button
            variant="outline"
            onClick={() => {
              const csv = buildCsv(tab, data);
              const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a'); a.href = url; a.download = `${tab}-report.csv`; a.click();
              setTimeout(() => URL.revokeObjectURL(url), 100);
            }}
          >
            Експорт CSV
          </Button>
        )}
      </div>

      {!data && !loading && (
        <div className="flex items-center justify-center h-64 text-muted-foreground text-[13px]">
          Оберіть параметри і натисніть «Сформувати»
        </div>
      )}

      {loading && (
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
            <StatCard label="Середній чек" value={data.totalOrders > 0 ? fmt(data.totalRevenue / data.totalOrders) : '—'} />
          </div>
          <div className="bg-surface rounded-xl border border-border p-5">
            <h3 className="font-medium text-foreground mb-4">Виручка по днях</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.rows}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={v => (v / 1000).toFixed(0) + 'к'} />
                <Tooltip formatter={(v) => fmt(Number(v ?? 0))} />
                <Bar dataKey="revenue" fill="#3b82f6" name="Виручка" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="bg-surface rounded-xl border border-border p-5">
            <h3 className="font-medium text-foreground mb-4">Роботи vs Запчастини</h3>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={data.rows}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => fmt(Number(v ?? 0))} />
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
                {data.rows.map((r) => (
                  <TableRow key={r.employeeId}>
                    <TableCell className="font-medium text-foreground">{r.employeeName}</TableCell>
                    <TableCell className="text-right">{fmtNum(r.totalNormoHours)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{r.linesCount}</TableCell>
                    <TableCell className="text-right font-semibold">{fmt(r.totalAmount)}</TableCell>
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
                      <div className="text-xs text-foreground-faint font-mono">{i.goodSku ?? '—'}</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{i.warehouseName}</TableCell>
                    <TableCell className="text-right">{fmtNum(i.quantity)} {i.unit}</TableCell>
                    <TableCell className={cn('text-right font-medium', i.available <= 0 ? 'text-destructive' : 'text-success')}>
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
            <StatCard label="Дебіторська заборгованість" value={fmt(data.totalDebit)} sub="Клієнти нам" />
            <StatCard label="Кредиторська заборгованість" value={fmt(data.totalCredit)} sub="Ми постачальникам" />
          </div>
          <div className="grid grid-cols-2 gap-6">
            <div className="bg-surface rounded-xl border border-border p-5">
              <h3 className="font-medium text-foreground mb-4">Структура</h3>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={[
                    { name: 'Дебіторська', value: data.totalDebit },
                    { name: 'Кредиторська', value: data.totalCredit },
                  ]} cx="50%" cy="50%" outerRadius={80} dataKey="value">
                    <Cell fill="#3b82f6" />
                    <Cell fill="#ef4444" />
                  </Pie>
                  <Tooltip formatter={(v) => fmt(Number(v ?? 0))} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="bg-surface rounded-xl border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Контрагент</TableHead>
                    <TableHead className="text-right">Баланс</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.filter((r) => r.balance !== 0).map((r) => (
                    <TableRow key={r.counterpartyId}>
                      <TableCell className="text-foreground">{r.counterpartyName}</TableCell>
                      <TableCell className={cn('text-right font-semibold', r.balance > 0 ? 'text-destructive' : 'text-success')}>
                        {r.balance > 0 ? '+' : ''}{fmt(r.balance)}
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
            <StatCard label="Виручка" value={fmt(data.totalRevenue)} sub={`${data.ordersCount} нарядів`} />
            <StatCard label="Собівартість" value={fmt(data.totalCost)} sub={`Запч: ${fmt(data.totalCostParts)}`} />
            <StatCard label="Валовий прибуток" value={fmt(data.grossProfit)} />
            <StatCard label="Маржинальність" value={`${data.margin.toFixed(1)}%`} sub={data.margin >= 30 ? '✓ Норма' : '↓ Нижче норми'} />
          </div>
          <div className="bg-surface rounded-xl border border-border p-5">
            <h3 className="font-medium text-foreground mb-4">Структура витрат</h3>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={[
                    { name: 'Запчастини', value: data.totalCostParts },
                    { name: 'Праця (40%)', value: data.totalCostLabor },
                    { name: 'Прибуток', value: Math.max(0, data.grossProfit) },
                  ]}
                  cx="50%" cy="50%" outerRadius={90} dataKey="value"
                >
                  <Cell fill="#f59e0b" />
                  <Cell fill="#8b5cf6" />
                  <Cell fill="#10b981" />
                </Pie>
                <Tooltip formatter={(v) => fmt(Number(v ?? 0))} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
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
                  { label: '— Запчастини (собівартість)', value: data.totalCostParts, pct: data.totalRevenue > 0 ? (data.totalCostParts / data.totalRevenue) * 100 : 0 },
                  { label: '— Праця (оцінка 40%)', value: data.totalCostLabor, pct: data.totalRevenue > 0 ? (data.totalCostLabor / data.totalRevenue) * 100 : 0 },
                  { label: 'Валовий прибуток', value: data.grossProfit, pct: data.margin },
                ].map((row) => (
                  <TableRow key={row.label}>
                    <TableCell className="text-foreground">{row.label}</TableCell>
                    <TableCell className={cn('text-right font-semibold', row.label === 'Валовий прибуток' ? (row.value >= 0 ? 'text-success' : 'text-destructive') : '')}>
                      {fmt(row.value)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">{row.pct.toFixed(1)}%</TableCell>
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
          <div className="bg-surface rounded-xl border border-border p-5">
            <h3 className="font-medium text-foreground mb-4">Завантаженість підйомників (%)</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.rows} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" domain={[0, 100]} tickFormatter={v => v + '%'} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="liftName" tick={{ fontSize: 11 }} width={120} />
                <Tooltip formatter={(v) => Number(v ?? 0).toFixed(1) + '%'} />
                <Bar dataKey="loadPercent" fill="#3b82f6" radius={[0, 4, 4, 0]} name="Завантаженість">
                  {data.rows.map((_, idx: number) => (
                    <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
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
                {data.rows.map((r) => (
                  <TableRow key={r.liftId}>
                    <TableCell className="font-medium text-foreground">{r.liftName}</TableCell>
                    <TableCell className="text-muted-foreground">{r.zoneName}</TableCell>
                    <TableCell className="text-right">{r.totalSlots}</TableCell>
                    <TableCell className="text-right">{fmtNum(r.totalHours)}г</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-24 bg-secondary rounded-full h-2">
                          <div className="bg-primary h-2 rounded-full" style={{ width: `${Math.min(r.loadPercent, 100)}%` }} />
                        </div>
                        <span className={cn('text-xs font-medium', r.loadPercent >= 80 ? 'text-destructive' : r.loadPercent >= 50 ? 'text-warning' : 'text-success')}>
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
  if (tab === 'profitability' && data._tab === 'profitability') {
    const rows = [
      ['Показник', 'Сума', '% до виручки'],
      ['Виручка', data.totalRevenue, '100.0'],
      ['Запчастини', data.totalCostParts, data.totalRevenue > 0 ? ((data.totalCostParts / data.totalRevenue) * 100).toFixed(1) : '0'],
      ['Праця', data.totalCostLabor, data.totalRevenue > 0 ? ((data.totalCostLabor / data.totalRevenue) * 100).toFixed(1) : '0'],
      ['Валовий прибуток', data.grossProfit, data.margin.toFixed(1)],
    ];
    return rows.map(r => r.join(';')).join('\n');
  }
  return '';
}
