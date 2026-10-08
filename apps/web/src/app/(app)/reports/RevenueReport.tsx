'use client';

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ApiSchema } from '@sto/shared';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { escapeCsvCell } from '@/lib/utils';
import { fmtMoney, fmtDate } from '@/lib/format';
import { StatCard } from './StatCard';

type RevenueData = ApiSchema<'RevenueReportDto'>;

function fmt(n: number) {
  return fmtMoney(n) + ' ₴';
}

/**
 * CSV звіту «Виручка». Ті самі три величини, що й на екрані: сума без ПДВ, ПДВ, сума з ПДВ.
 * Роботи й запчастини — суми рядків нарядів, як їх віддає бекенд.
 */
export function buildRevenueCsv(data: RevenueData, t: TFunction<'reports'>): string {
  const rows: (string | number)[][] = [
    [
      t('page.csv.date'),
      t('page.csv.ordersCount'),
      t('page.csv.labor'),
      t('page.csv.parts'),
      t('page.csv.revenue'),
      t('page.csv.vat'),
      t('page.csv.revenueWithVat'),
    ],
    ...data.rows.map(r => [r.date, r.count, r.labor, r.parts, r.revenue, r.vat, r.revenueWithVat]),
  ];
  return rows.map(r => r.map(c => escapeCsvCell(c)).join(';')).join('\n');
}

/**
 * Звіт «Виручка»: виручка рахується БЕЗ ПДВ (BR-WO-007), ПДВ і сума з ПДВ показані поруч —
 * у картках-підсумках і в таблиці по днях. Середній чек — від суми без ПДВ.
 */
export function RevenueReport({ data, charts }: { data: RevenueData; charts?: ReactNode }) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label={t('page.revenue.totalRevenue')} value={fmt(data.totalRevenue)} />
        <StatCard label={t('page.revenue.totalVat')} value={fmt(data.totalVat)} />
        <StatCard
          label={t('page.revenue.totalRevenueWithVat')}
          value={fmt(data.totalRevenueWithVat)}
        />
        <StatCard label={t('page.revenue.totalOrders')} value={String(data.totalOrders)} />
        <StatCard
          label={t('page.revenue.avgCheck')}
          value={data.totalOrders > 0 ? fmt(data.totalRevenue / data.totalOrders) : '—'}
        />
      </div>
      {charts}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <h3 className="font-medium text-foreground px-4 pt-4 pb-2">
          {t('page.revenue.byDayTitle')}
        </h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('page.revenue.colDate')}</TableHead>
              <TableHead className="text-right">{t('page.revenue.colOrders')}</TableHead>
              <TableHead className="text-right">{t('page.revenue.colLabor')}</TableHead>
              <TableHead className="text-right">{t('page.revenue.colParts')}</TableHead>
              <TableHead className="text-right">{t('page.revenue.colRevenue')}</TableHead>
              <TableHead className="text-right">{t('page.revenue.colVat')}</TableHead>
              <TableHead className="text-right">{t('page.revenue.colRevenueWithVat')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  {t('page.revenue.noRows')}
                </TableCell>
              </TableRow>
            )}
            {data.rows.map(r => (
              <TableRow key={r.date}>
                <TableCell className="text-foreground">{fmtDate(r.date)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {r.count}
                </TableCell>
                <TableCell className="text-right tabular-nums">{fmt(r.labor)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(r.parts)}</TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {fmt(r.revenue)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {fmt(r.vat)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-semibold">
                  {fmt(r.revenueWithVat)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          {data.rows.length > 0 && (
            <tfoot>
              <tr
                className="border-t border-border bg-secondary/50"
                data-testid="revenue-total-row"
              >
                <td className="px-4 py-2 font-medium text-foreground">
                  {t('page.revenue.rowTotal')}
                </td>
                <td className="px-4 py-2 text-right tabular-nums font-semibold">
                  {data.totalOrders}
                </td>
                <td />
                <td />
                <td className="px-4 py-2 text-right tabular-nums font-semibold">
                  {fmt(data.totalRevenue)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums font-semibold">
                  {fmt(data.totalVat)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums font-semibold">
                  {fmt(data.totalRevenueWithVat)}
                </td>
              </tr>
            </tfoot>
          )}
        </Table>
      </div>
    </div>
  );
}
