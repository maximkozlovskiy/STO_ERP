'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Централізована навігація до пов'язаного документа.
 *
 * Частина сутностей має власні detail-маршрути ([id]), решта відкривається у
 * модалці свого списку через deep-link `?open=<id>` (mount-once ефект на сторінці
 * списку читає param, відкриває модалку й чистить URL — дзеркалить PurchaseOrder
 * Bug #596). SupplierReturn не має власного списку — живе на сторінці замовлень,
 * тож використовує окремий param `openReturn=`, щоб не колідувати з `open=` (PO).
 */
export interface LinkedNav {
  toWorkOrder: (id: string) => void;
  toSupplierPayment: (id: string) => void;
  toCounterparty: (id: string) => void;
  toInvoice: (id: string) => void;
  toPurchaseOrder: (id: string) => void;
  toStockDocument: (id: string) => void;
  toSupplierReturn: (id: string) => void;
}

export function useLinkedNav(): LinkedNav {
  const router = useRouter();
  return useMemo<LinkedNav>(
    () => ({
      // Routed detail pages
      toWorkOrder: id => router.push(`/work-orders/${id}`),
      toSupplierPayment: id => router.push(`/supplier-payments/${id}`),
      toCounterparty: id => router.push(`/counterparties/${id}`),
      // Modal-based lists via ?open= deep-link
      toInvoice: id => router.push(`/invoices?open=${id}`),
      toPurchaseOrder: id => router.push(`/purchase-orders?open=${id}`),
      toStockDocument: id => router.push(`/stock-documents?open=${id}`),
      // SupplierReturn lives inside the purchase-orders page (returns tab)
      toSupplierReturn: id => router.push(`/purchase-orders?openReturn=${id}`),
    }),
    [router],
  );
}
