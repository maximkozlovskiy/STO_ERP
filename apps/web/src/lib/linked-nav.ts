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

/**
 * Результат розбору deep-link параметрів на сторінці замовлень (purchase-orders).
 * `openPurchaseOrderId` → відкрити edit-модалку PO; `openSupplierReturnId` → відкрити
 * SR-модалку. SR-модалка на цій сторінці — ОДИН інстанс з `open` + `editId`, тож
 * недостатньо виставити лише editId: `srModalShouldOpen` явно каже, що open теж
 * має стати true (інакше editId виставлений, а модалка закрита → deep-link мертвий).
 */
export interface ResolvedDeepLink {
  openPurchaseOrderId: string | null;
  openSupplierReturnId: string | null;
  /** SR-модалку треба відкрити (open=true), не лише виставити editId. */
  srModalShouldOpen: boolean;
}

const DEEP_LINK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Чистий розбір deep-link параметрів `?open=` (PO) та `?openReturn=` (SR) на сторінці
 * замовлень. Валідні лише коректні UUID. Винесено з page.tsx, щоб зчеплення
 * «editId + open» для SR-модалки було покрите unit-тестом (Bug: openReturn виставляв
 * лише editId, модалка з open={srCreateOpen} лишалась закритою).
 */
export function resolvePurchaseOrdersDeepLink(
  get: (key: string) => string | null,
): ResolvedDeepLink {
  const openId = get('open');
  const openReturnId = get('openReturn');
  const validOpen = openId && DEEP_LINK_UUID_RE.test(openId) ? openId : null;
  const validReturn = openReturnId && DEEP_LINK_UUID_RE.test(openReturnId) ? openReturnId : null;
  return {
    openPurchaseOrderId: validOpen,
    openSupplierReturnId: validReturn,
    srModalShouldOpen: validReturn !== null,
  };
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
