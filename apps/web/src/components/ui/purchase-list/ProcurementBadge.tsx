'use client';

import { useTranslation } from 'react-i18next';
import { fmtQty } from '@/lib/format';
import { poStatusLabel } from '@/i18n/enumLabel';
import type { PurchaseListItem } from '@/hooks/api/usePurchaseLists';
import { cn } from '@/lib/utils';

interface ProcurementBadgeProps {
  /** Позиції списків купівлі цього рядка наряду (без скасованих). */
  items: PurchaseListItem[];
  /** Непокрита потреба рядка (BR-PL-014), базові одиниці; 0 — покрито. */
  shortage: number;
  unit?: string | null;
  className?: string;
}

const CHIP = 'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight';

/**
 * Стан товару наряду в закупівлі: «у списку СК-…», «замовлено ЗП-… (статус)», «прибуло N,
 * зарезервовано M», «нестача N». Читає позиції `GET /purchase-list-items/by-work-order/:id`.
 */
export function ProcurementBadge({ items, shortage, unit, className }: ProcurementBadgeProps) {
  const { t } = useTranslation('purchaseLists');
  const u = unit ? ` ${unit}` : '';
  const open = items.filter(i => i.status === 'OPEN');
  const ordered = items.filter(i => i.status === 'ORDERED');
  const received = items.reduce((s, i) => s + i.receivedQty, 0);
  const reserved = items.reduce((s, i) => s + i.reservedQty, 0);
  const lists = Array.from(new Set(open.map(i => i.listNumber)));
  const orders = Array.from(
    new Map(
      ordered
        .filter(i => i.purchaseOrderNumber)
        .map(i => [i.purchaseOrderNumber as string, i.purchaseOrderStatus]),
    ),
  );

  if (items.length === 0 && shortage <= 0) return null;
  return (
    <div className={cn('flex flex-wrap gap-1 mt-0.5', className)} data-testid="procurement-badge">
      {lists.length > 0 && (
        <span className={cn(CHIP, 'bg-secondary text-muted-foreground')}>
          {t('badge.inList', { numbers: lists.join(', ') })}
        </span>
      )}
      {orders.map(([number, status]) => (
        <span key={number} className={cn(CHIP, 'bg-info-subtle text-info-text')}>
          {t('badge.ordered', { number, status: poStatusLabel(status ?? '') })}
        </span>
      ))}
      {received > 0 && (
        <span className={cn(CHIP, 'bg-success-subtle text-success')}>
          {t('badge.received', { received: fmtQty(received), reserved: fmtQty(reserved), unit: u })}
        </span>
      )}
      {shortage > 0 && (
        <span className={cn(CHIP, 'bg-warning-subtle text-warning')}>
          {t('badge.shortage', { qty: fmtQty(shortage), unit: u })}
        </span>
      )}
    </div>
  );
}
