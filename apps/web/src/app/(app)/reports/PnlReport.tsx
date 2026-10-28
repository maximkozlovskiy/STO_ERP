'use client';

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ApiSchema } from '@sto/shared';
import { AlertTriangle } from 'lucide-react';
import { Table, TableHeader, TableBody, TableRow, TableHead } from '@/components/ui/table';
import { cn, escapeCsvCell } from '@/lib/utils';
import { fmtMoney } from '@/lib/format';
import { StatCard } from './StatCard';

type PnlData = ApiSchema<'PnlReportDto'>;
type PnlRow = PnlData['rows'][number];

function fmt(n: number) {
  return fmtMoney(n) + ' ₴';
}

/** `YYYY-MM` → `MM.YYYY` (як дата `DD.MM.YYYY` без дня; однаково на екрані й у CSV). */
export function pnlMonthLabel(month: string): string {
  return `${month.slice(5, 7)}.${month.slice(0, 4)}`;
}

/** Рядки-підсумки (виділені) і рядки статей (з відступом за рівнем дерева). */
const STRONG_KEYS: ReadonlySet<PnlRow['key']> = new Set(['grossProfit', 'netProfit']);
const isCategory = (r: PnlRow) => r.key === 'expenseCategory' || r.key === 'incomeCategory';

/** Назва рядка: для статті — її назва (або «Без статті»), для решти — підпис ключа. */
export function pnlRowLabel(r: PnlRow, t: TFunction<'reports'>): string {
  if (isCategory(r)) {
    if (r.label) return r.label;
    return r.categoryId ? t('page.pnl.unnamedCategory') : t('page.pnl.noCategory');
  }
  return t(`page.pnl.rows.${r.key}`);
}

/**
 * CSV звіту P&L (BR-RPT-030): рядки звіту × місяці + «Разом», числа — числами (escapeCsvCell пише
 * їх із десятковою комою). Статті — з відступом «· » за рівнем, щоб дерево читалось у таблиці.
 */
export function buildPnlCsv(data: PnlData, t: TFunction<'reports'>): string {
  const rows: (string | number)[][] = [
    [t('page.pnl.colIndicator'), ...data.months.map(pnlMonthLabel), t('page.pnl.colTotal')],
    ...data.rows.map(r => [
      (isCategory(r) ? '· '.repeat((r.depth ?? 0) + 1) : '') + pnlRowLabel(r, t),
      ...r.amounts,
      r.total,
    ]),
  ];
  return rows.map(r => r.map(c => escapeCsvCell(c)).join(';')).join('\n');
}

const DEPTH_PAD = ['pl-8', 'pl-12', 'pl-16', 'pl-20'] as const;

function MoneyCell({ value, strong }: { value: number; strong?: boolean }) {
  return (
    <td
      className={cn(
        'px-4 py-2 text-right tabular-nums whitespace-nowrap',
        strong && 'font-semibold',
        value < 0 && 'text-destructive',
      )}
    >
      {fmt(value)}
    </td>
  );
}

/**
 * Звіт P&L (BR-RPT-030): прибутки й збитки по київських місяцях, метод нарахування, без ПДВ.
 * Чистий прибуток — підсумок таблиці (tfoot); від'ємні суми — червоним.
 */
export function PnlReport({ data }: { data: PnlData }) {
  const { t } = useTranslation('reports');
  const totalOf = (key: PnlRow['key']) => data.rows.find(r => r.key === key)?.total ?? 0;
  const net = data.rows.find(r => r.key === 'netProfit');
  const body = data.rows.filter(r => r.key !== 'netProfit');
  const netTotal = totalOf('netProfit');

  return (
    <div className="space-y-6" data-testid="pnl-report">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label={t('page.pnl.rows.revenue')} value={fmt(totalOf('revenue'))} />
        <StatCard label={t('page.pnl.rows.grossProfit')} value={fmt(totalOf('grossProfit'))} />
        <StatCard
          label={t('page.pnl.rows.netProfit')}
          value={fmt(netTotal)}
          sub={netTotal < 0 ? t('page.pnl.loss') : undefined}
        />
      </div>

      {(data.unknownCostPartsCount > 0 || data.payrollMissingMonths.length > 0) && (
        <div className="space-y-2" data-testid="pnl-warnings">
          {data.payrollMissingMonths.length > 0 && (
            <div className="flex items-center gap-2 text-[13px] text-warning-text bg-warning-subtle border border-warning/20 rounded-lg px-3 py-2">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t('page.pnl.payrollMissing', {
                months: data.payrollMissingMonths.map(pnlMonthLabel).join(', '),
              })}
            </div>
          )}
          {data.unknownCostPartsCount > 0 && (
            <div className="flex items-center gap-2 text-[13px] text-warning-text bg-warning-subtle border border-warning/20 rounded-lg px-3 py-2">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t('page.pnl.unknownCost', { count: data.unknownCostPartsCount })}
            </div>
          )}
        </div>
      )}

      <div className="bg-surface rounded-xl border border-border overflow-x-auto">
        <Table>
          <colgroup>
            <col className="min-w-56" />
            {data.months.map(m => (
              <col key={m} className="w-32" />
            ))}
            <col className="w-36" />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead>{t('page.pnl.colIndicator')}</TableHead>
              {data.months.map(m => (
                <TableHead key={m} className="text-right">
                  {pnlMonthLabel(m)}
                </TableHead>
              ))}
              <TableHead className="text-right">{t('page.pnl.colTotal')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {body.map(r => {
              const strong = STRONG_KEYS.has(r.key);
              const category = isCategory(r);
              return (
                <tr
                  key={`${r.key}:${r.categoryId ?? ''}`}
                  data-testid={`pnl-row-${r.key}`}
                  className={cn('border-b border-border', strong && 'bg-secondary/50')}
                >
                  <td
                    className={cn(
                      'px-4 py-2',
                      category
                        ? cn('text-muted-foreground', DEPTH_PAD[Math.min(r.depth ?? 0, 3)])
                        : 'text-foreground',
                      strong && 'font-semibold',
                    )}
                  >
                    {pnlRowLabel(r, t)}
                  </td>
                  {r.amounts.map((v, i) => (
                    <MoneyCell key={data.months[i] ?? i} value={v} strong={strong} />
                  ))}
                  <MoneyCell value={r.total} strong />
                </tr>
              );
            })}
          </TableBody>
          {net && (
            <tfoot>
              <tr
                className="border-t border-border bg-secondary/50"
                data-testid="pnl-row-netProfit"
              >
                <td className="px-4 py-2 font-semibold text-foreground">
                  {t('page.pnl.rows.netProfit')}
                </td>
                {net.amounts.map((v, i) => (
                  <MoneyCell key={data.months[i] ?? i} value={v} strong />
                ))}
                <MoneyCell value={net.total} strong />
              </tr>
            </tfoot>
          )}
        </Table>
        <p className="px-4 py-2 text-[12px] text-muted-foreground">{t('page.pnl.note')}</p>
      </div>
    </div>
  );
}
