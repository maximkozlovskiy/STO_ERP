'use client';

import { useTranslation } from 'react-i18next';
import { cn, workOrderVatSplit } from '@/lib/utils';
import { fmtMoney } from '@/lib/format';
import { VatTotalsSummary } from '@/components/ui/work-order/VatTotalsSummary';

export interface WorkOrderTotalsProps {
  totalLabor: number;
  totalActualLabor: number;
  totalParts: number;
  totalAmount: number;
  /** Сума без ПДВ; відсутня у відповіді старого кешу — тоді ПДВ у сумі немає. */
  totalNet?: number | null;
  paidAmount: number;
  /** Символ валюти наряду. */
  sym?: string | null;
}

/**
 * Блок підсумків картки наряду.
 *
 * Роботи й запчастини — суми РЯДКІВ. За BR-WO-007 вони дорівнюють «Разом» лише без ПДВ і в
 * режимі «ПДВ у ціні»; у режимі «ПДВ зверху» їхня сума — це «Сума без ПДВ», а «Разом» більше
 * на ПДВ. Тому ПДВ показано окремим рядком: без нього «роботи + запчастини» не сходились би
 * з сумою в шапці. Оплачено порівнюється з `totalAmount` — сумою до сплати.
 *
 * Коли фактичні години відрізняються від планових, показано обидва значення робіт: сума
 * наряду рахується від факту.
 */
export function WorkOrderTotals({
  totalLabor,
  totalActualLabor,
  totalParts,
  totalAmount,
  totalNet,
  paidAmount,
  sym: symProp,
}: WorkOrderTotalsProps) {
  const sym = symProp ?? '';
  const { t } = useTranslation('workOrders');
  const split = workOrderVatSplit({ totalAmount, totalNet });
  const laborDiffers = totalActualLabor !== totalLabor;
  return (
    <div className="bg-surface rounded-xl border border-border p-5 space-y-4 text-sm">
      <div className="grid grid-cols-3 gap-4">
        <div>
          <p className="text-xs text-muted-foreground">
            {laborDiffers ? t('detail.laborPlan') : t('detail.labor')}
          </p>
          <p className="text-lg font-semibold text-foreground tabular-nums">
            {fmtMoney(totalLabor)} {sym}
          </p>
          {laborDiffers && (
            <p className="text-xs text-muted-foreground mt-1">
              {t('detail.actualPrefix')}
              <span className="font-medium text-foreground tabular-nums">
                {fmtMoney(totalActualLabor)} {sym}
              </span>
            </p>
          )}
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{t('detail.parts')}</p>
          <p className="text-lg font-semibold text-foreground tabular-nums">
            {fmtMoney(totalParts)} {sym}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{t('detail.paid')}</p>
          <p
            className={cn(
              'text-lg font-semibold tabular-nums',
              paidAmount >= totalAmount ? 'text-success' : 'text-foreground',
            )}
            data-testid="wo-totals-paid"
          >
            {fmtMoney(paidAmount)} {sym}
          </p>
        </div>
      </div>
      <div className="flex justify-end border-t border-border pt-3">
        <VatTotalsSummary split={split} currencySymbol={sym} />
      </div>
    </div>
  );
}
