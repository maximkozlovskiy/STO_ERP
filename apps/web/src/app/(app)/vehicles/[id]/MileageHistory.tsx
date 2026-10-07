'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useVehicleMileage } from '@/hooks/api/useVehicleMileage';
import { fmtDate, fmtInt } from '@/lib/format';

// recharts — важкий; вантажимо окремим чанком і лише коли графік справді потрібен (≥2 записи).
const MileageChart = dynamic(() => import('./MileageChart'), {
  ssr: false,
  loading: () => <div className="skeleton h-55 w-full rounded-lg" />,
});

/** Приріст зі знаком: «+1 200» / «−800» (типографський мінус). */
function fmtDelta(delta: number): string {
  if (delta > 0) return `+${fmtInt(delta)}`;
  if (delta < 0) return `−${fmtInt(Math.abs(delta))}`;
  return '0';
}

/**
 * Секція «Історія пробігу» картки авто: графік «дата → пробіг» + таблиця записів.
 * Дані — GET /vehicles/:id/mileage (від старішого до новішого). Ознаку відкату
 * (`isRollback`) рахує бекенд — тут її лише показуємо, не переобчислюємо.
 */
export function MileageHistory({ vehicleId }: { vehicleId: string }) {
  const { t } = useTranslation('vehicles');
  const { data, isLoading, isError, error, refetch, isFetching } = useVehicleMileage(vehicleId);
  const points = data ?? [];

  return (
    <div className="bg-surface rounded-xl border border-border p-5" data-testid="mileage-history">
      <h2 className="font-semibold text-foreground mb-4">{t('card.mileage.title')}</h2>

      {isLoading ? (
        <div className="space-y-2" data-testid="mileage-skeleton" aria-busy="true">
          <div className="skeleton h-40 w-full rounded-lg" />
          <div className="skeleton h-8 w-full rounded-lg" />
          <div className="skeleton h-8 w-full rounded-lg" />
        </div>
      ) : isError ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2"
        >
          <span>
            {error instanceof Error && error.message ? error.message : t('card.loadError')}
          </span>
          <Button size="sm" variant="outline" loading={isFetching} onClick={() => void refetch()}>
            {t('card.mileage.retry')}
          </Button>
        </div>
      ) : points.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('card.mileage.empty')}</p>
      ) : (
        <div className="space-y-4">
          {points.length >= 2 && <MileageChart points={points} />}

          <div className="border border-border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <colgroup>
                <col className="w-28" />
                <col />
                <col className="w-32" />
                <col className="w-32" />
              </colgroup>
              <thead>
                <tr className="text-xs text-muted-foreground bg-secondary">
                  <th className="text-left font-medium px-3 py-2">
                    {t('card.mileage.columns.date')}
                  </th>
                  <th className="text-left font-medium px-3 py-2">
                    {t('card.mileage.columns.workOrder')}
                  </th>
                  <th className="text-right font-medium px-3 py-2">
                    {t('card.mileage.columns.mileage')}
                  </th>
                  <th className="text-right font-medium px-3 py-2">
                    {t('card.mileage.columns.delta')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {points.map((p, i) => {
                  const prev = i > 0 ? points[i - 1] : undefined;
                  return (
                    <tr
                      key={p.workOrderId}
                      className={p.isRollback ? 'bg-warning-subtle' : undefined}
                      data-rollback={p.isRollback ? 'true' : undefined}
                    >
                      <td className="px-3 py-2 text-foreground whitespace-nowrap">
                        {fmtDate(p.date)}
                      </td>
                      <td className="px-3 py-2">
                        <Link
                          href={`/work-orders/${p.workOrderId}`}
                          className="text-primary hover:underline"
                        >
                          {p.workOrderNumber}
                        </Link>
                        {p.isRollback && (
                          <span className="mt-0.5 flex items-center gap-1 text-xs text-warning-text">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            {t('card.mileage.rollback')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-foreground">
                        {fmtInt(p.mileage)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums ${
                          p.isRollback ? 'text-warning-text font-medium' : 'text-muted-foreground'
                        }`}
                      >
                        {prev ? fmtDelta(p.mileage - prev.mileage) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
