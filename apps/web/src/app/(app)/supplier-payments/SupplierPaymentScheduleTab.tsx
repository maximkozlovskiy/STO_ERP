'use client';

import { useMemo } from 'react';
import { Wallet } from 'lucide-react';
import { useSupplierPaymentsSchedule } from '@/hooks/api/useSupplierPayments';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { fmtMoney, kyivToday, addDaysISO } from '@/lib/format';
import { cn } from '@/lib/utils';

const WINDOW_DAYS = 20;

/** Сума у гривнях або порожньо, якщо 0/undefined. */
function cell(n: number | undefined): string {
  return n && n > 0.005 ? fmtMoney(n) : '';
}

/** DD.MM з YYYY-MM-DD. */
function ddmm(ymd: string): string {
  const [, m, d] = ymd.split('-');
  return `${d}.${m}`;
}

export function SupplierPaymentScheduleTab() {
  const from = useMemo(() => kyivToday(), []);
  const to = useMemo(() => addDaysISO(from, WINDOW_DAYS - 1), [from]);

  const { data, isLoading, error } = useSupplierPaymentsSchedule(from, to);

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (error) {
    return (
      <div className="text-destructive text-sm py-8 text-center">
        {error instanceof Error ? error.message : 'Помилка завантаження'}
      </div>
    );
  }
  if (!data || data.suppliers.length === 0) {
    return (
      <EmptyState
        icon={Wallet}
        title="Немає запланованих оплат"
        description="Тут з'являться борги постачальникам за отриманими замовленнями з датою оплати."
      />
    );
  }

  const { dates, suppliers, totals } = data;

  return (
    <div className="flex flex-1 min-h-0">
      <div className="table-scroll-container flex-1 min-h-0 min-w-0 overflow-auto bg-surface border border-border rounded-xl">
        <table className="w-full text-[12px] tabular-nums border-collapse">
          <thead className="sticky top-0 z-10 bg-secondary">
            <tr className="text-muted-foreground">
              <th className="sticky left-0 z-20 bg-secondary text-left font-medium px-3 py-2 min-w-40 border-b border-r border-border">
                Постачальник
              </th>
              <th className="text-right font-medium px-2 py-2 min-w-24 border-b border-border bg-destructive-subtle text-destructive-text">
                Протерміновані
              </th>
              {dates.map(d => (
                <th
                  key={d}
                  className="text-right font-medium px-2 py-2 min-w-16 border-b border-border whitespace-nowrap"
                >
                  {ddmm(d)}
                </th>
              ))}
              <th className="text-right font-medium px-2 py-2 min-w-24 border-b border-l border-border bg-success-subtle text-success">
                Планові
              </th>
            </tr>
          </thead>
          <tbody>
            {/* Підсумковий рядок «Разом» */}
            <tr className="font-semibold bg-muted/40">
              <td className="sticky left-0 z-10 bg-muted/40 px-3 py-1.5 border-b border-r border-border">
                Разом:
              </td>
              <td
                className={cn(
                  'text-right px-2 py-1.5 border-b border-border',
                  totals.overdue > 0.005 && 'bg-destructive text-white',
                )}
              >
                {cell(totals.overdue)}
              </td>
              {dates.map(d => (
                <td key={d} className="text-right px-2 py-1.5 border-b border-border">
                  {cell(totals.byDate[d])}
                </td>
              ))}
              <td className="text-right px-2 py-1.5 border-b border-l border-border">
                {cell(totals.planned)}
              </td>
            </tr>

            {/* Рядки постачальників */}
            {suppliers.map(row => (
              <tr key={row.supplierId} className="hover:bg-secondary/40 transition-colors">
                <td className="sticky left-0 z-10 bg-surface px-3 py-1.5 border-b border-r border-border text-foreground whitespace-nowrap">
                  {row.supplierName}
                </td>
                <td
                  className={cn(
                    'text-right px-2 py-1.5 border-b border-border',
                    row.overdue > 0.005 && 'bg-destructive text-white',
                  )}
                >
                  {cell(row.overdue)}
                </td>
                {dates.map(d => {
                  const v = row.byDate[d];
                  return (
                    <td
                      key={d}
                      className={cn(
                        'text-right px-2 py-1.5 border-b border-border',
                        v && v > 0.005 && 'bg-warning-subtle text-warning font-medium',
                      )}
                    >
                      {cell(v)}
                    </td>
                  );
                })}
                <td
                  className={cn(
                    'text-right px-2 py-1.5 border-b border-l border-border',
                    row.planned > 0.005 && 'bg-success-subtle text-success font-medium',
                  )}
                >
                  {cell(row.planned)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
