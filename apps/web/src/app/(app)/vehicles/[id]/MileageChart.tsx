'use client';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { VehicleMileagePoint } from '@sto/shared';
import { fmtDate, fmtInt } from '@/lib/format';

interface ChartRow {
  /** Мітка часу (мс) — вісь X справжня часова, тож нерівні інтервали між нарядами видно. */
  ts: number;
  mileage: number;
  isRollback: boolean;
}

interface MileageDotProps {
  cx?: number;
  cy?: number;
  payload?: ChartRow;
}

// Точка відкату пробігу — попереджувальним кольором і більша, решта — основним.
function MileageDot({ cx, cy, payload }: MileageDotProps) {
  if (cx == null || cy == null) return null;
  const rollback = payload?.isRollback === true;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={rollback ? 5 : 3}
      fill={rollback ? 'var(--color-warning)' : 'var(--color-primary)'}
      stroke="var(--color-surface)"
      strokeWidth={1.5}
    />
  );
}

// memo: `points` — пряме посилання на query-data (стабільна ідентичність між ре-рендерами
// картки авто), тож recharts не проходить повний reconcile на кожен локальний setState сторінки.
function MileageChart({ points }: { points: VehicleMileagePoint[] }) {
  const { t } = useTranslation('vehicles');
  const data = useMemo<ChartRow[]>(
    () =>
      points.map(p => ({
        ts: new Date(p.date).getTime(),
        mileage: p.mileage,
        isRollback: p.isRollback,
      })),
    [points],
  );

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ left: 0, right: 12, top: 8 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
        <XAxis
          dataKey="ts"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
          axisLine={false}
          tickLine={false}
          // fmtDate прив'язаний до Europe/Kyiv (lib/format): наряд, закритий о 23:30 за Києвом,
          // не «переїжджає» на сусідній день на машині з іншим часовим поясом.
          tickFormatter={(ts: number) => fmtDate(new Date(ts))}
          minTickGap={24}
        />
        <YAxis
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => fmtInt(v)}
          allowDecimals={false}
          domain={['auto', 'auto']}
          width={64}
        />
        <Tooltip
          // Фон і колір тексту — токенами: recharts за замовчуванням малює підказку на білому,
          // а підпис (дата) успадковує колір сторінки → у темній темі світлий текст на білому.
          contentStyle={{
            borderRadius: 8,
            border: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-surface-raised)',
            color: 'var(--color-foreground)',
            fontSize: 12,
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          }}
          formatter={v => [fmtInt(Number(v ?? 0)), t('card.mileage.chartSeries')]}
          labelFormatter={ts => fmtDate(new Date(Number(ts)))}
        />
        <Line
          type="monotone"
          dataKey="mileage"
          stroke="var(--color-primary)"
          strokeWidth={2}
          dot={<MileageDot />}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export default memo(MileageChart);
