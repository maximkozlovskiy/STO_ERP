'use client';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { fmtMoney, fmtDate } from '@/lib/format';

interface RevenuePoint {
  date: string;
  revenue: number;
}

// Module-level Intl singleton for chart axis ticks (day + short-month label).
// Replaces per-tick Intl.DateTimeFormat construction inside recharts tickFormatter callback.
const TICK_DATE_FMT = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short' });

// Thin proxy to lib/format singleton — replaces per-tooltip Intl.NumberFormat.
function fmt(v: number) {
  return fmtMoney(v) + ' грн';
}

function yFmt(v: number): string {
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'м';
  if (v >= 1_000) return (v / 1_000).toFixed(1).replace(/\.0$/, '') + 'к';
  return String(v);
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
          // T12:00:00 безпечно дає правильний день у Kyiv TZ незалежно
          // від local TZ браузера (полудень UTC = 14:00/15:00 Kyiv — не може
          // відкотитись на попередній день).
          tickFormatter={d => TICK_DATE_FMT.format(new Date(d + 'T12:00:00'))}
        />
        <YAxis
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={yFmt}
          allowDecimals={false}
          domain={[0, 'auto']}
          width={48}
        />
        <Tooltip
          cursor={{ fill: 'var(--color-primary-subtle)' }}
          contentStyle={{
            borderRadius: 8,
            border: '1px solid var(--color-border)',
            fontSize: 12,
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          }}
          formatter={v => [fmt(Number(v ?? 0)), 'Виручка']}
          labelFormatter={d => fmtDate(new Date(d + 'T12:00:00'))}
        />
        <Bar dataKey="revenue" fill="var(--color-primary)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
