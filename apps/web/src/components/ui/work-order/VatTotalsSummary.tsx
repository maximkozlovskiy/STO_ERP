'use client';

import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { VatSplit } from '@/lib/utils';
import { fmtMoney } from '@/lib/format';

export interface VatTotalsSummaryProps {
  /** Три величини підсумку; `vat = 0` означає, що ПДВ у сумі немає. */
  split: VatSplit;
  /** Символ валюти документа. */
  currencySymbol?: string;
  className?: string;
}

/**
 * Підсумок документа за BR-WO-007: коли ПДВ є — три рядки «Сума без ПДВ / ПДВ / Разом»,
 * коли немає — один рядок «Разом». Спільний для картки наряду і попереднього перегляду
 * у модалці наряду, щоб обидва екрани показували ту саму розкладку.
 */
export function VatTotalsSummary({
  split,
  currencySymbol = '₴',
  className,
}: VatTotalsSummaryProps) {
  const { t } = useTranslation('workOrders');
  const hasVat = split.vat > 0;
  return (
    <dl data-testid="vat-totals" className={cn('w-full max-w-xs space-y-1 text-sm', className)}>
      {hasVat && (
        <>
          <div className="flex items-baseline justify-between gap-6" data-testid="vat-totals-net">
            <dt className="text-muted-foreground">{t('totals.net')}</dt>
            <dd className="text-right tabular-nums text-foreground">
              {fmtMoney(split.net)} {currencySymbol}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-6" data-testid="vat-totals-vat">
            <dt className="text-muted-foreground">{t('totals.vat')}</dt>
            <dd className="text-right tabular-nums text-foreground">
              {fmtMoney(split.vat)} {currencySymbol}
            </dd>
          </div>
        </>
      )}
      <div
        className={cn(
          'flex items-baseline justify-between gap-6',
          hasVat && 'border-t border-border pt-1',
        )}
        data-testid="vat-totals-gross"
      >
        <dt className="font-medium text-foreground">{t('totals.gross')}</dt>
        <dd className="text-right text-base font-semibold tabular-nums text-foreground">
          {fmtMoney(split.gross)} {currencySymbol}
        </dd>
      </div>
    </dl>
  );
}
