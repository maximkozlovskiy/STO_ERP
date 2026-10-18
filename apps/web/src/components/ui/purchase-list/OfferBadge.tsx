'use client';

import { useTranslation } from 'react-i18next';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useNow } from '@/hooks/useNow';
import { isOfferStale } from '@/hooks/api/useSupplierOffers';
import type { PurchaseListItem } from '@/hooks/api/usePurchaseLists';

/** Давність пропозиції коротко: «щойно», «12 хв тому», «3 год тому», «2 дн. тому». */
export function ageText(ms: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return t('badge.justNow');
  const h = Math.floor(min / 60);
  const age =
    min < 60
      ? t('badge.minutes', { count: min })
      : h < 48
        ? t('badge.hours', { count: h })
        : t('badge.daysAgo', { count: Math.floor(h / 24) });
  return t('badge.age', { age });
}

/**
 * Обрана пропозиція позиції (знімок `offer*`, BR-SOFR-006): склад, термін, давність, позначка
 * «застаріла» (старша за TTL; невідомий TTL — без позначки). Ціни не показує: ціну позиції
 * (у гривні) показує колонка «Ціна», замаскована для ролей без закупівельних цін (BR-SOFR-010).
 */
export function OfferBadge({
  item,
  ttlMinutes,
}: {
  item: PurchaseListItem;
  ttlMinutes: number | undefined;
}) {
  const { t } = useTranslation('supplierApi');
  const now = useNow(60_000);
  if (!item.offerKey) return null;
  const stale = isOfferStale(item.offeredAt, ttlMinutes, now);
  const term =
    item.offerDeliveryDays !== null
      ? t('offers.days', { count: item.offerDeliveryDays })
      : item.offerDeliveryDate
        ? fmtDate(item.offerDeliveryDate)
        : null;
  const parts = [
    item.offerWarehouseName ?? item.offerWarehouseCode,
    term,
    item.offeredAt ? ageText(now.getTime() - new Date(item.offeredAt).getTime(), t) : null,
  ].filter(Boolean);
  return (
    <span
      data-testid="offer-badge"
      title={[
        t('badge.title'),
        [item.offerArticle, item.offerBrand].filter(Boolean).join(' '),
        item.offeredAt ? fmtDateTime(item.offeredAt) : null,
        item.offerChosenBy === 'AUTO' ? t('badge.auto') : t('badge.manual'),
      ]
        .filter(Boolean)
        .join(' · ')}
      className={cn(
        'mt-0.5 inline-flex flex-wrap items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-tight',
        stale
          ? 'border-warning-border bg-warning-subtle text-warning-text'
          : 'border-info-border bg-info-subtle text-info-text',
      )}
    >
      <span>{parts.join(' · ')}</span>
      {item.offerIsAnalog && <span className="font-medium">· {t('badge.analog')}</span>}
      {stale && <span className="font-medium">· {t('badge.stale')}</span>}
    </span>
  );
}
