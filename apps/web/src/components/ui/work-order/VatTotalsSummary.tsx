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
  /**
   * `stack` (типово) — стовпчиком під таблицями; `inline` — в один рядок у футері картки
   * документа (варіант A): ті самі рядки й `data-testid`, «Разом» — крупніше.
   */
  layout?: 'stack' | 'inline';
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
  layout = 'stack',
  className,
}: VatTotalsSummaryProps) {
  const { t } = useTranslation('workOrders');
  const hasVat = split.vat > 0;
  const inline = layout === 'inline';
  const row = inline ? 'flex items-baseline gap-2' : 'flex items-baseline justify-between gap-6';
  return (
    <dl
      data-testid="vat-totals"
      className={cn(
        inline
          ? 'flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[13px]'
          : 'w-full max-w-xs space-y-1 text-sm',
        className,
      )}
    >
      {hasVat && (
        <>
          <div className={row} data-testid="vat-totals-net">
            <dt className="text-muted-foreground">{t('totals.net')}</dt>
            <dd
              className={cn('text-right tabular-nums text-foreground', inline && 'font-semibold')}
            >
              {fmtMoney(split.net)} {currencySymbol}
            </dd>
          </div>
          <div className={row} data-testid="vat-totals-vat">
            <dt className="text-muted-foreground">{t('totals.vat')}</dt>
            <dd
              className={cn('text-right tabular-nums text-foreground', inline && 'font-semibold')}
            >
              {fmtMoney(split.vat)} {currencySymbol}
            </dd>
          </div>
        </>
      )}
      <div
        className={cn(row, !inline && hasVat && 'border-t border-border pt-1')}
        data-testid="vat-totals-gross"
      >
        <dt className={inline ? 'text-muted-foreground' : 'font-medium text-foreground'}>
          {t('totals.gross')}
        </dt>
        <dd
          className={cn(
            'text-right tabular-nums text-foreground',
            inline ? 'text-xl font-bold' : 'text-base font-semibold',
          )}
        >
          {fmtMoney(split.gross)} {currencySymbol}
        </dd>
      </div>
    </dl>
  );
}
