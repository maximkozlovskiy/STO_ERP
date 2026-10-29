'use client';

import type { ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import type { ApiSchema } from '@sto/shared';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { fmtMoney, fmtPercent, memoByLocale } from '@/lib/format';
import { useLinkedNav } from '@/lib/linked-nav';
import { StatCard } from './StatCard';
import { workOrdersFilterHref } from '../work-orders/url-filter';

/**
 * Таблиці вкладок «Наряди», «Звіт по складу», «Взаєморозрахунки», «Завантаженість» (винесено з
 * page.tsx). Рядок веде до документа чи картки: клік по рядку, а для клавіатури — кнопка-назва в
 * першій комірці (клік по ній спливає до рядка, тож перехід один).
 */

type WorkOrdersData = ApiSchema<'WorkOrdersReportDto'>;
type StockData = ApiSchema<'StockReportDto'>;
type SettlementsData = ApiSchema<'SettlementsReportDto'>;
type LoadData = ApiSchema<'LoadReportDto'>;
type LoadRow = LoadData['rows'][number];

const SettlementsChart = dynamic(() => import('./ReportsCharts').then(m => m.SettlementsChart), {
  ssr: false,
  loading: () => <div className="h-52 bg-surface-hover animate-pulse rounded-xl" />,
});
const LoadChart = dynamic(() => import('./ReportsCharts').then(m => m.LoadChart), {
  ssr: false,
  loading: () => <div className="h-72 bg-surface-hover animate-pulse rounded-xl" />,
});

function fmt(n: number) {
  return fmtMoney(n) + ' ₴';
}
// Один десятковий знак — мовою інтерфейсу, один форматер на мову.
const getNumFmt1 = memoByLocale(loc => new Intl.NumberFormat(loc, { maximumFractionDigits: 1 }));
export function fmtNum(n: number) {
  return getNumFmt1().format(n);
}

/** Назва в першій комірці клікабельного рядка — фокусована кнопка без власного обробника. */
function RowLink({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      className="text-left font-medium text-foreground hover:text-primary hover:underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
    >
      {children}
    </button>
  );
}

export function WorkOrdersReportView({
  data,
  from,
  to,
}: {
  data: WorkOrdersData;
  from: string;
  to: string;
}) {
  const { t } = useTranslation('reports');
  const router = useRouter();
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <StatCard
          label={t('page.workOrders.totalNormoHours')}
          value={fmtNum(data.totalNormoHours)}
        />
        <StatCard label={t('page.workOrders.totalAmount')} value={fmt(data.totalAmount)} />
        <StatCard label={t('page.workOrders.mechanics')} value={String(data.rows.length)} />
      </div>
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('page.workOrders.colMechanic')}</TableHead>
              <TableHead className="text-right">{t('page.workOrders.colNormoHours')}</TableHead>
              <TableHead className="text-right">{t('page.workOrders.colLines')}</TableHead>
              <TableHead className="text-right">{t('page.workOrders.colAmount')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map(r => (
              <TableRow
                key={r.employeeId}
                data-testid="report-wo-row"
                title={t('page.workOrders.openOrders')}
                // Наряди механіка за період звіту (звіт рахує його рядки робіт у нарядах періоду).
                onClick={() =>
                  router.push(
                    workOrdersFilterHref({ id: r.employeeId, name: r.employeeName }, from, to),
                  )
                }
              >
                <TableCell>
                  <RowLink>{r.employeeName}</RowLink>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmtNum(r.totalNormoHours)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {r.linesCount}
                </TableCell>
                <TableCell className="text-right tabular-nums font-semibold">
                  {fmt(r.totalAmount)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function StockReportView({
  data,
  onOpenGood,
}: {
  data: StockData;
  /** Відкрити картку товару; немає — рядки не клікабельні (роль без доступу до товарів). */
  onOpenGood?: (goodId: string) => void;
}) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <StatCard label={t('page.stock.itemsCount')} value={String(data.stockItems.length)} />
        <StatCard label={t('page.stock.totalValue')} value={fmt(data.totalValue)} />
      </div>
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('page.stock.colGood')}</TableHead>
              <TableHead>{t('page.stock.colWarehouse')}</TableHead>
              <TableHead className="text-right">{t('page.stock.colQuantity')}</TableHead>
              <TableHead className="text-right">{t('page.stock.colAvailable')}</TableHead>
              <TableHead className="text-right">{t('page.stock.colValue')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.stockItems.map(i => (
              <TableRow
                key={`${i.goodId}::${i.warehouseName}`}
                data-testid="report-stock-row"
                onClick={onOpenGood ? () => onOpenGood(i.goodId) : undefined}
              >
                <TableCell>
                  {onOpenGood ? (
                    <RowLink>{i.goodName}</RowLink>
                  ) : (
                    <div className="font-medium text-foreground">{i.goodName}</div>
                  )}
                  <div className="text-xs text-foreground-faint font-mono">{i.goodSku ?? '—'}</div>
                </TableCell>
                <TableCell className="text-muted-foreground">{i.warehouseName}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmtNum(i.quantity)} {i.unit}
                </TableCell>
                <TableCell
                  className={cn(
                    'text-right tabular-nums font-medium',
                    i.available <= 0 ? 'text-destructive' : 'text-success',
                  )}
                >
                  {fmtNum(i.available)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{fmt(i.value)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function SettlementsReportView({ data }: { data: SettlementsData }) {
  const { t } = useTranslation('reports');
  const nav = useLinkedNav();
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <StatCard
          label={t('page.settlements.totalDebit')}
          value={fmt(data.totalDebit)}
          sub={t('page.settlements.totalDebitSub')}
        />
        <StatCard
          label={t('page.settlements.totalCredit')}
          value={fmt(data.totalCredit)}
          sub={t('page.settlements.totalCreditSub')}
        />
      </div>
      <div className="grid grid-cols-2 gap-6">
        <SettlementsChart rows={data.rows} />
        <div className="bg-surface rounded-xl border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('page.settlements.colCounterparty')}</TableHead>
                <TableHead className="text-right">{t('page.settlements.colBalance')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows
                .filter(r => r.balance !== 0)
                .map(r => (
                  <TableRow
                    key={r.counterpartyId}
                    data-testid="report-settlement-row"
                    onClick={() => nav.toCounterparty(r.counterpartyId)}
                  >
                    <TableCell>
                      <RowLink>{r.counterpartyName}</RowLink>
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right tabular-nums font-semibold',
                        r.balance > 0 ? 'text-destructive' : 'text-success',
                      )}
                    >
                      {r.balance > 0 ? '+' : ''}
                      {fmt(r.balance)}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

/**
 * «Завантаженість»: підйомники із записами — за відсотком (більші зверху); без жодного запису за
 * період — не стовпчиками, а одним рядком «Ще N підйомників без записів» (як у підсумках місяця
 * календаря).
 */
export function splitLoadRows(rows: readonly LoadRow[]): { busy: LoadRow[]; idle: number } {
  const busy = rows
    .filter(r => r.totalSlots > 0)
    .sort((a, b) => b.loadPercent - a.loadPercent || a.liftName.localeCompare(b.liftName, 'uk'));
  return { busy, idle: rows.length - busy.length };
}

export function LoadReportView({ data }: { data: LoadData }) {
  const { t } = useTranslation('reports');
  const { busy, idle } = splitLoadRows(data.rows);
  return (
    <div className="space-y-6">
      {busy.length > 0 && <LoadChart rows={busy} />}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('page.load.colLift')}</TableHead>
              <TableHead>{t('page.load.colZone')}</TableHead>
              <TableHead className="text-right">{t('page.load.colSlots')}</TableHead>
              <TableHead className="text-right">{t('page.load.colHours')}</TableHead>
              <TableHead className="text-right">{t('page.load.colLoad')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {busy.map(r => (
              <TableRow key={r.liftId} data-testid="report-load-row">
                <TableCell className="font-medium text-foreground">{r.liftName}</TableCell>
                <TableCell className="text-muted-foreground">{r.zoneName}</TableCell>
                <TableCell className="text-right tabular-nums">{r.totalSlots}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmtNum(r.totalHours)}
                  {t('page.load.hoursSuffix')}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-24 bg-secondary rounded-full h-2">
                      <div
                        className="bg-primary h-2 rounded-full"
                        style={{ width: `${Math.min(r.loadPercent, 100)}%` }}
                      />
                    </div>
                    <span
                      className={cn(
                        'w-12 text-xs font-medium tabular-nums',
                        r.loadPercent >= 80
                          ? 'text-destructive'
                          : r.loadPercent >= 50
                            ? 'text-warning'
                            : 'text-success',
                      )}
                    >
                      {fmtPercent(r.loadPercent)}
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {idle > 0 && (
              <tr data-testid="report-load-idle">
                <td colSpan={5} className="px-4 py-2 text-xs text-muted-foreground">
                  {t('page.load.idleLifts', { count: idle })}
                </td>
              </tr>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
