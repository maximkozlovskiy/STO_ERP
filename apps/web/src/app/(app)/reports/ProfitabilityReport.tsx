'use client';

import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiSchema } from '@sto/shared';
import { Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { fmtMoney, fmtPercent } from '@/lib/format';
import { StatCard } from './StatCard';
import { ProfitabilitySettingsModal } from './ProfitabilitySettingsModal';

type ProfitabilityData = ApiSchema<'ProfitabilityReportDto'>;

/** Поріг «Норма» маржинальності, % — у коді, не в налаштуваннях (BR-RPT-035). */
export const MARGIN_NORM_PERCENT = 30;

function fmt(n: number) {
  return fmtMoney(n) + ' ₴';
}

/** Частка праці відповіді (0…1) → «40%» — для підпису «Праця (оцінка N%)». */
export function laborPctLabel(ratio: number): string {
  return fmtPercent(Math.round(ratio * 1000) / 10);
}

/**
 * Вкладка «Рентабельність» (BR-RPT-023, BR-RPT-035): виручка без ПДВ, собівартість (запчастини +
 * праця як частка робіт з налаштувань), валовий прибуток і маржа. OWNER / ADMIN бачать кнопку
 * «Налаштування звіту» — частка праці.
 */
export function ProfitabilityReport({
  data,
  chart,
  canEditSettings = false,
}: {
  data: ProfitabilityData;
  /** Діаграма структури витрат (динамічний імпорт сторінки). */
  chart: ReactNode;
  canEditSettings?: boolean;
}) {
  const { t } = useTranslation('reports');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pct = (v: number) => (data.totalRevenue > 0 ? (v / data.totalRevenue) * 100 : 0);
  const rows = [
    {
      id: 'revenue',
      label: t('page.profitability.rowRevenue'),
      value: data.totalRevenue,
      pct: 100,
    },
    {
      id: 'parts',
      label: t('page.profitability.rowParts'),
      value: data.totalCostParts,
      pct: pct(data.totalCostParts),
    },
    {
      id: 'labor',
      label: t('page.profitability.rowLabor', { pct: laborPctLabel(data.laborCostRatio) }),
      value: data.totalCostLabor,
      pct: pct(data.totalCostLabor),
    },
    {
      id: 'grossProfit',
      label: t('page.profitability.rowGrossProfit'),
      value: data.grossProfit,
      pct: data.margin,
    },
    { id: 'vat', label: t('page.profitability.rowVat'), value: data.totalVat, pct: null },
    {
      id: 'revenueWithVat',
      label: t('page.profitability.rowRevenueWithVat'),
      value: data.totalRevenueWithVat,
      pct: null,
    },
  ];

  return (
    <div className="space-y-6" data-testid="profitability-report">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          label={t('page.profitability.revenue')}
          value={fmt(data.totalRevenue)}
          sub={t('page.profitability.revenueSub', { count: data.ordersCount })}
        />
        <StatCard
          label={t('page.profitability.cost')}
          value={fmt(data.totalCost)}
          sub={t('page.profitability.costSub', { parts: fmt(data.totalCostParts) })}
        />
        <StatCard label={t('page.profitability.grossProfit')} value={fmt(data.grossProfit)} />
        <StatCard
          label={t('page.profitability.margin')}
          value={fmtPercent(data.margin)}
          sub={
            data.margin >= MARGIN_NORM_PERCENT
              ? t('page.profitability.marginOk')
              : t('page.profitability.marginLow')
          }
        />
      </div>
      {canEditSettings && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Settings2 className="h-4 w-4" aria-hidden="true" />}
            onClick={() => setSettingsOpen(true)}
          >
            {t('page.profitability.settings.open')}
          </Button>
        </div>
      )}
      {chart}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('page.profitability.colIndicator')}</TableHead>
              <TableHead className="text-right">{t('page.profitability.colAmount')}</TableHead>
              <TableHead className="text-right">
                {t('page.profitability.colPctOfRevenue')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(row => (
              <TableRow key={row.id} data-testid={`profitability-row-${row.id}`}>
                <TableCell className="text-foreground">{row.label}</TableCell>
                <TableCell
                  className={cn(
                    'text-right font-semibold tabular-nums',
                    row.id === 'grossProfit'
                      ? row.value >= 0
                        ? 'text-success'
                        : 'text-destructive'
                      : '',
                  )}
                >
                  {fmt(row.value)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {fmtPercent(row.pct)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="px-4 py-2 text-[12px] text-muted-foreground">
          {t('page.profitability.vatNote')}
        </p>
      </div>

      {canEditSettings && (
        <ProfitabilitySettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          laborCostRatio={data.laborCostRatio}
        />
      )}
    </div>
  );
}
