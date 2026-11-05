'use client';

import type { MouseEvent, ReactNode } from 'react';
import { useLinkedNav, type LinkedNav } from '@/lib/linked-nav';
import type { LinkedDocKind } from '@/lib/nav';

const OPEN: Record<LinkedDocKind, (nav: LinkedNav, id: string) => void> = {
  workOrder: (nav, id) => nav.toWorkOrder(id),
  counterparty: (nav, id) => nav.toCounterparty(id),
  invoice: (nav, id) => nav.toInvoice(id),
  purchaseOrder: (nav, id) => nav.toPurchaseOrder(id),
  stockDocument: (nav, id) => nav.toStockDocument(id),
  supplierReturn: (nav, id) => nav.toSupplierReturn(id),
  purchaseList: (nav, id) => nav.toPurchaseList(id),
  calendarDay: (nav, startAtIso) => nav.toCalendarDay(startAtIso),
  warranty: (nav, id) => nav.toWarranty(id),
};

export interface LinkedDocRefProps {
  kind: LinkedDocKind;
  /** Id документа; для `calendarDay` — ISO-час запису (`toCalendarDay`). */
  id: string;
  label: ReactNode;
  /** Вигляд посилання; типово — `text-primary hover:underline`. */
  className?: string;
  /** Вигляд тексту для ролі без доступу. */
  textClassName?: string;
  title?: string;
  'aria-label'?: string;
  /** Посилання в рядку, клік по якому відкриває інше (картку операції), — не пускати клік далі. */
  stopPropagation?: boolean;
}

/**
 * Номер пов'язаного документа: посилання (`useLinkedNav`), якщо роль відкриє документ
 * (`nav.canOpen`), інакше — звичайний текст, а не перехід на 403.
 */
export function LinkedDocRef({
  kind,
  id,
  label,
  className = 'text-primary hover:underline',
  textClassName,
  title,
  'aria-label': ariaLabel,
  stopPropagation = false,
}: LinkedDocRefProps) {
  const nav = useLinkedNav();
  if (!nav.canOpen(kind)) return <span className={textClassName}>{label}</span>;
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (stopPropagation) e.stopPropagation();
    OPEN[kind](nav, id);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      className={className}
    >
      {label}
    </button>
  );
}
