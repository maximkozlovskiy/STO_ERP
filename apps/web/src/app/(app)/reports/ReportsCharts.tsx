'use client';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  Legend,
  LabelList,
} from 'recharts';
import { useTranslation } from 'react-i18next';
import type { ApiSchema } from '@sto/shared';
import { fmtDate, fmtMoney, fmtPercent } from '@/lib/format';

type RevenueRow = ApiSchema<'RevenueRowDto'>;
type SettlementRow = { counterpartyId: string; counterpartyName: string; balance: number };
type LoadRow = {
  liftId: string;
  liftName: string;
  zoneName: string;
  totalSlots: number;
  totalHours: number;
  loadPercent: number;
};
type ProfitabilityData = ApiSchema<'ProfitabilityReportDto'>;

function fmt(n: number) {
  return fmtMoney(n) + ' ₴';
}

/** Підпис осі днів: `YYYY-MM-DD` → «ДД.ММ» (рядком, без часового поясу браузера). */
export function axisDayLabel(ymd: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}` : ymd;
}
/** Підказка дня — повна дата «ДД.ММ.РРРР». */
const tooltipDay = (label: unknown) => (typeof label === 'string' ? fmtDate(label) : String(label));

// Масштабований форматер для YAxis: уникає дублів при малих значеннях
function yFmt(v: number): string {
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'м';
  if (v >= 1_000) return (v / 1_000).toFixed(1).replace(/\.0$/, '') + 'к';
  return String(v);
}

export function RevenueCharts({ rows }: { rows: RevenueRow[] }) {
  const { t } = useTranslation('reports');
  return (
    <>
      <div className="bg-surface rounded-xl border border-border p-5">
        <h3 className="font-medium text-foreground mb-4">{t('charts.revenueByDay')}</h3>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={axisDayLabel} />
            <YAxis
              tick={{ fontSize: 11 }}
              tickFormatter={yFmt}
              allowDecimals={false}
              domain={[0, 'auto']}
              width={52}
            />
            <Tooltip formatter={v => fmt(Number(v ?? 0))} labelFormatter={tooltipDay} />
            <Bar
              dataKey="revenue"
              fill="#3b82f6"
              name={t('charts.revenue')}
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="bg-surface rounded-xl border border-border p-5">
        <h3 className="font-medium text-foreground mb-4">{t('charts.laborVsParts')}</h3>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={axisDayLabel} />
            <YAxis
              tick={{ fontSize: 11 }}
              tickFormatter={yFmt}
              allowDecimals={false}
              domain={[0, 'auto']}
              width={52}
            />
            <Tooltip formatter={v => fmt(Number(v ?? 0))} labelFormatter={tooltipDay} />
            <Line
              type="monotone"
              dataKey="labor"
              stroke="#10b981"
              name={t('charts.labor')}
              dot={false}
              strokeWidth={2}
            />
            <Line
              type="monotone"
              dataKey="parts"
              stroke="#f59e0b"
              name={t('charts.parts')}
              dot={false}
              strokeWidth={2}
            />
            <Legend />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

export function SettlementsChart({ rows }: { rows: SettlementRow[] }) {
  const { t } = useTranslation('reports');
  const debit = rows.filter(r => r.balance > 0).reduce((s, r) => s + r.balance, 0);
  const credit = Math.abs(rows.filter(r => r.balance < 0).reduce((s, r) => s + r.balance, 0));
  return (
    <div className="bg-surface rounded-xl border border-border p-5">
      <h3 className="font-medium text-foreground mb-4">{t('charts.structure')}</h3>
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie
            data={[
              { name: t('charts.debit'), value: debit },
              { name: t('charts.credit'), value: credit },
            ]}
            cx="50%"
            cy="50%"
            outerRadius={80}
            dataKey="value"
          >
            <Cell fill="#3b82f6" />
            <Cell fill="#ef4444" />
          </Pie>
          <Tooltip formatter={v => fmt(Number(v ?? 0))} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ProfitabilityChart({ data }: { data: ProfitabilityData }) {
  const { t } = useTranslation('reports');
  return (
    <div className="bg-surface rounded-xl border border-border p-5">
      <h3 className="font-medium text-foreground mb-4">{t('charts.costStructure')}</h3>
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={[
              { name: t('charts.profParts'), value: data.totalCostParts },
              { name: t('charts.profLabor'), value: data.totalCostLabor },
              { name: t('charts.profProfit'), value: Math.max(0, data.grossProfit) },
            ]}
            cx="50%"
            cy="50%"
            outerRadius={90}
            dataKey="value"
          >
            <Cell fill="#f59e0b" />
            <Cell fill="#8b5cf6" />
            <Cell fill="#10b981" />
          </Pie>
          <Tooltip formatter={v => fmt(Number(v ?? 0))} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * «Завантаженість»: рядки вже відсортовані (більші зверху) й без підйомників без записів
 * (`splitLoadRows`). Біля стовпчика — підпис відсотка, вісь — до 100 % або до найбільшого.
 */
export function LoadChart({ rows }: { rows: LoadRow[] }) {
  const { t } = useTranslation('reports');
  return (
    <div className="bg-surface rounded-xl border border-border p-5">
      <h3 className="font-medium text-foreground mb-4">{t('charts.liftLoad')}</h3>
      <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 40 + 40)}>
        <BarChart data={rows} layout="vertical" margin={{ right: 48 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis
            type="number"
            domain={[0, (max: number) => Math.max(100, Math.ceil(max / 10) * 10)]}
            tickFormatter={v => fmtPercent(Number(v))}
            tick={{ fontSize: 11 }}
            allowDecimals={false}
            tickCount={6}
          />
          <YAxis type="category" dataKey="liftName" tick={{ fontSize: 11 }} width={120} />
          <Tooltip formatter={v => fmtPercent(Number(v ?? 0))} />
          <Bar
            dataKey="loadPercent"
            fill="#3b82f6"
            radius={[0, 4, 4, 0]}
            minPointSize={2}
            name={t('charts.load')}
          >
            <LabelList
              dataKey="loadPercent"
              position="right"
              formatter={(v: unknown) => fmtPercent(Number(v ?? 0))}
              style={{ fontSize: 11, fill: 'var(--color-foreground)' }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
