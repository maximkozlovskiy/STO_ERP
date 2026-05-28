'use client';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface RevenuePoint { date: string; revenue: number }

function fmt(v: number) {
  return v.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' грн';
}

export default function RevenueChart({ data }: { data: RevenuePoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ left: -10 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={d =>
            new Date(d + 'T00:00').toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' })
          }
        />
        <YAxis
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={v => (v / 1000).toFixed(0) + 'к'}
        />
        <Tooltip
          cursor={{ fill: 'var(--color-primary-subtle)' }}
          contentStyle={{
            borderRadius: 8, border: '1px solid var(--color-border)',
            fontSize: 12, boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          }}
          formatter={(v) => [fmt(Number(v ?? 0)), 'Виручка']}
          labelFormatter={d => new Date(d + 'T00:00').toLocaleDateString('uk-UA')}
        />
        <Bar dataKey="revenue" fill="var(--color-primary)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
