'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { ListPlus } from 'lucide-react';
import { WO_PROCUREMENT_ACTIVE_STATUSES } from '@sto/shared';
import { useAuth } from '@/lib/auth';
import { toast } from '@/lib/toast';
import {
  purchaseListsKeys,
  useWorkOrderProcurement,
  type PurchaseListItem,
} from '@/hooks/api/usePurchaseLists';
import { AddToListDialog, type AddToListRow } from './AddToListDialog';

/** Позиції наряду в картці бачать ці ролі (BR-PL-015: + механік). */
const VIEW_ROLES: readonly string[] = ['OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST', 'MECHANIC'];
/** Надсилати товари з наряду до списку купівлі (BR-PL-003, BR-PL-015). */
const SEND_ROLES: readonly string[] = ['OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST'];

export interface WorkOrderProcurementState {
  itemsByPart: Map<string, PurchaseListItem[]>;
  shortageByPart: Map<string, number>;
}

/**
 * Стан закупівлі товарів наряду для його картки: позиції списків купівлі кожного рядка й непокрита
 * потреба (`GET /purchase-list-items/by-work-order/:id`). Для ролей без доступу — порожньо.
 */
export function useWorkOrderProcurementState(
  workOrderId: string | null | undefined,
): WorkOrderProcurementState | undefined {
  const { employee } = useAuth();
  const allowed = VIEW_ROLES.includes(employee?.role ?? '');
  const { data } = useWorkOrderProcurement(workOrderId, allowed);
  return useMemo(() => {
    // Відповідь неочікуваної форми (старий API, заглушка) не має ламати картку наряду.
    if (!data || !Array.isArray(data.items) || !Array.isArray(data.shortage)) return undefined;
    const itemsByPart = new Map<string, PurchaseListItem[]>();
    for (const item of data.items) {
      if (!item.workOrderPartId) continue;
      itemsByPart.set(item.workOrderPartId, [
        ...(itemsByPart.get(item.workOrderPartId) ?? []),
        item,
      ]);
    }
    const shortageByPart = new Map(data.shortage.map(s => [s.workOrderPartId, s.shortage]));
    return { itemsByPart, shortageByPart };
  }, [data]);
}

/**
 * Скидає стан закупівлі після зміни товарів наряду (додано, змінено, видалено, імпорт): новий рядок
 * інакше не має нестачі в закешованій відповіді, і «До списку купівлі» каже «нестачі немає», а
 * менша кількість урізає позиції списків (BR-PL-013) — бейдж показував би старі.
 */
export function useInvalidateProcurement(): () => void {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: purchaseListsKeys.all });
  }, [qc]);
}

interface SendToListButtonProps {
  workOrderId: string;
  status: string;
  /** Збережені рядки товарів наряду (з `id`). */
  parts: Array<{ id: string; goodName: string; unit?: string | null }>;
  procurement: WorkOrderProcurementState | undefined;
  /** Діалог поверх картки-модалки: картка не закривається тим самим Escape (GOTCHAS 2026-10-12). */
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

/**
 * «До списку купівлі» в картці наряду: товари, яких бракує (непокрита потреба > 0), — у діалог
 * `AddToListDialog`. Кнопка лише для активного наряду (WO_PROCUREMENT_ACTIVE_STATUSES) і ролей,
 * що надсилають (BR-PL-015).
 */
export function SendToListButton({
  workOrderId,
  status,
  parts,
  procurement,
  onOpenChange,
  disabled,
}: SendToListButtonProps) {
  const { t } = useTranslation('purchaseLists');
  const { employee } = useAuth();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AddToListRow[]>([]);

  if (!SEND_ROLES.includes(employee?.role ?? '')) return null;
  if (!WO_PROCUREMENT_ACTIVE_STATUSES.includes(status)) return null;

  const openDialog = () => {
    const missing = parts
      .map(p => ({ part: p, shortage: procurement?.shortageByPart.get(p.id) ?? 0 }))
      .filter(x => x.shortage > 0);
    if (missing.length === 0) {
      toast.info(t('card.noShortage'));
      return;
    }
    setRows(
      missing.map(({ part, shortage }) => ({
        workOrderId,
        workOrderPartId: part.id,
        label: part.goodName,
        shortage,
        unit: part.unit,
      })),
    );
    onOpenChange?.(true);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    onOpenChange?.(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        disabled={disabled || parts.length === 0}
        title={parts.length === 0 ? t('card.saveFirst') : undefined}
        className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ListPlus className="h-3.5 w-3.5" />
        {t('card.addToList')}
      </button>
      <AddToListDialog open={open} onClose={close} rows={rows} />
    </>
  );
}
