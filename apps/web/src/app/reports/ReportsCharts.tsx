'use client';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, Legend,
} from 'recharts';

type RevenueRow = { date: string; revenue: number; labor: number; parts: number; count: number };
type SettlementRow = { counterpartyId: string; counterpartyName: string; balance: number };
type LoadRow = { liftId: string; liftName: string; zoneName: string; totalSlots: number; totalHours: number; loadPercent: number };
type ProfitabilityData = { totalRevenue: number; totalCost: number; totalCostParts: number; totalCostLabor: number; grossProfit: number; margin: number; ordersCount: number };

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

function fmt(n: number) {
  return n.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₴';
}

export function RevenueCharts({ rows }: { rows: RevenueRow[] }) {
  return (
    <>
      <div className="bg-surface rounded-xl border border-border p-5">
        <h3 className="font-medium text-foreground mb-4">Виручка по днях</h3>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={rows}>
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
          <LineChart data={rows}>
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
    </>
  );
}

export function SettlementsChart({ rows }: { rows: SettlementRow[] }) {
  const debit = rows.filter(r => r.balance > 0).reduce((s, r) => s + r.balance, 0);
  const credit = Math.abs(rows.filter(r => r.balance < 0).reduce((s, r) => s + r.balance, 0));
  return (
    <div className="bg-surface rounded-xl border border-border p-5">
      <h3 className="font-medium text-foreground mb-4">Структура</h3>
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie data={[
            { name: 'Дебіторська', value: debit },
            { name: 'Кредиторська', value: credit },
          ]} cx="50%" cy="50%" outerRadius={80} dataKey="value">
            <Cell fill="#3b82f6" />
            <Cell fill="#ef4444" />
          </Pie>
          <Tooltip formatter={(v) => fmt(Number(v ?? 0))} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ProfitabilityChart({ data }: { data: ProfitabilityData }) {
  return (
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
  );
}

export function LoadChart({ rows }: { rows: LoadRow[] }) {
  return (
    <div className="bg-surface rounded-xl border border-border p-5">
      <h3 className="font-medium text-foreground mb-4">Завантаженість підйомників (%)</h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={rows} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tickFormatter={v => v + '%'} tick={{ fontSize: 11 }} />
          <YAxis type="category" dataKey="liftName" tick={{ fontSize: 11 }} width={120} />
          <Tooltip formatter={(v) => Number(v ?? 0).toFixed(1) + '%'} />
          <Bar dataKey="loadPercent" fill="#3b82f6" radius={[0, 4, 4, 0]} name="Завантаженість">
            {rows.map((_, idx: number) => (
              <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
