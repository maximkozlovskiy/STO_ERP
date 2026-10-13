'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTabBarContext } from '@/contexts/TabBarContext';
import { invoicesKeys } from '@/hooks/api/useInvoices';
import {
  invalidateBalanceAffected,
  invalidatePurchaseSideEffects,
  invalidateStockDocumentSideEffects,
  invalidateWorkOrderSideEffects,
} from '@/lib/cache-invalidation';

const CreateWorkOrderModal = dynamic(
  () => import('@/components/ui/CreateWorkOrderModal').then(m => m.CreateWorkOrderModal),
  { ssr: false },
);
const InvoiceCreateModal = dynamic(
  () => import('@/components/ui/InvoiceCreateModal').then(m => m.InvoiceCreateModal),
  { ssr: false },
);
const PurchaseOrderCreateModal = dynamic(
  () => import('@/components/ui/PurchaseOrderCreateModal').then(m => m.PurchaseOrderCreateModal),
  { ssr: false },
);
const StockDocumentCreateModal = dynamic(
  () => import('@/components/ui/StockDocumentCreateModal').then(m => m.StockDocumentCreateModal),
  { ssr: false },
);

/**
 * Стандарт згортання картки документа у вкладку: кожен `modalKey`, який картка передає в
 * `minimizeModal`, МУСИТЬ мати запис тут — інакше вкладка з'являється, а клік по ній нічого не
 * відкриває (так було з рахунком, замовленням і складським документом: відновлювався лише наряд).
 * `idProp` — ключ у `restoreProps`; він же має бути в `IDENTITY_KEYS` у TabBarContext.
 */
export const RESTORABLE_MODALS = {
  // Картка наряду вміє FSM-перехід (→COMPLETED списує склад і нараховує борг), тому скидаємо
  // всі залежні кеші, а не лише список нарядів.
  'work-order': { idProp: 'workOrderId', invalidate: invalidateWorkOrderSideEffects },
  invoice: {
    idProp: 'invoiceId',
    invalidate: (qc: QueryClient) => {
      void qc.invalidateQueries({ queryKey: invoicesKeys.all });
      invalidateBalanceAffected(qc);
    },
  },
  'purchase-order': { idProp: 'purchaseOrderId', invalidate: invalidatePurchaseSideEffects },
  'stock-document': { idProp: 'stockDocumentId', invalidate: invalidateStockDocumentSideEffects },
} as const;

export type RestorableModalKey = keyof typeof RESTORABLE_MODALS;

interface Restored {
  key: RestorableModalKey;
  docId: string;
  // UUID вкладки (не id документа) — щоб closeTab прибрав саме її.
  tabId: string;
}

/** Відкриває картку документа, згорнуту у вкладку, коли по вкладці клікнули. */
export function RestoredDocumentModal() {
  const { pendingRestore, setPendingRestore, closeTab } = useTabBarContext();
  const queryClient = useQueryClient();
  const [restored, setRestored] = useState<Restored | null>(null);
  // true, коли користувач знову натиснув «згорнути»: onClose НЕ має прибирати вкладку.
  const minimizingRef = useRef(false);

  useEffect(() => {
    if (!pendingRestore) return;
    const key = pendingRestore.modalKey;
    if (Object.hasOwn(RESTORABLE_MODALS, key)) {
      const def = RESTORABLE_MODALS[key as RestorableModalKey];
      const raw = pendingRestore.restoreProps[def.idProp];
      if (typeof raw === 'string' && raw.length > 0) {
        setRestored({ key: key as RestorableModalKey, docId: raw, tabId: pendingRestore.id });
      }
    }
    // Скидаємо завжди: невідомий modalKey (вкладка зі старої версії в localStorage) інакше
    // лишився б у стані й блокував наступні відкриття тієї ж вкладки.
    setPendingRestore(null);
  }, [pendingRestore, setPendingRestore]);

  if (!restored) return null;

  const invalidate = () => RESTORABLE_MODALS[restored.key].invalidate(queryClient);
  const common = {
    open: true,
    onClose: () => {
      if (!minimizingRef.current) closeTab(restored.tabId);
      minimizingRef.current = false;
      setRestored(null);
      invalidate();
    },
    onMinimize: () => {
      minimizingRef.current = true;
    },
  };

  switch (restored.key) {
    case 'work-order':
      return (
        <CreateWorkOrderModal {...common} workOrderId={restored.docId} onUpdated={invalidate} />
      );
    case 'invoice':
      return <InvoiceCreateModal {...common} invoiceId={restored.docId} onSaved={invalidate} />;
    case 'purchase-order':
      return (
        <PurchaseOrderCreateModal
          {...common}
          purchaseOrderId={restored.docId}
          onSaved={invalidate}
        />
      );
    case 'stock-document':
      return (
        <StockDocumentCreateModal
          {...common}
          stockDocumentId={restored.docId}
          onSaved={invalidate}
        />
      );
  }
}
