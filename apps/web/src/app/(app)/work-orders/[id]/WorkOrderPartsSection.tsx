'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { fmtMoney } from '@/lib/format';
import { XlsxImportButton } from '@/components/ui/xlsx-import-button';
import { WorkOrderAddPartModal } from '@/components/ui/WorkOrderAddPartModal';

interface WorkOrderPart {
  id: string;
  workOrderId?: string;
  goodId: string;
  goodName?: string;
  goodInternalCode?: string | null;
  goodSku?: string | null;
  goodBrandName?: string | null;
  unitOfMeasureId?: string | null;
  unitShortName?: string;
  coefficient?: number;
  warehouseId: string;
  quantity: number;
  costPrice?: number | null;
  price: number;
  amount: number;
  createdAt?: string;
}

interface Warehouse {
  id: string;
  name: string;
  isMain: boolean;
}

interface WorkOrderPartsSectionProps {
  woId: string;
  parts: WorkOrderPart[];
  /** Reference data — passed down to AddPartModal. */
  warehouses: Warehouse[];
  /** Pre-fills the warehouse selector for sequential adds. */
  initialWarehouseId?: string;
  /** Reload parent state after add/delete/import. */
  onChanged: () => void;
  /** Locks add/delete when WO status is non-editable. */
  disabled?: boolean;
  /** Surface delete errors at the page level (preserves original UX). */
  onError?: (msg: string) => void;
}

export function WorkOrderPartsSection({
  woId,
  parts,
  warehouses,
  initialWarehouseId,
  onChanged,
  disabled,
  onError,
}: WorkOrderPartsSectionProps) {
  const features = useUiFeatures();
  const { confirm, dialogProps } = useConfirm();
  const [partModal, setPartModal] = useState(false);
  const [deletingPartId, setDeletingPartId] = useState<string | null>(null);

  const removePart = async (partId: string) => {
    if (!(await confirm({ title: 'Видалити запчастину?', variant: 'destructive' }))) return;
    setDeletingPartId(partId);
    onError?.('');
    try {
      await apiFetch<void>(`/work-orders/${woId}/parts/${partId}`, { method: 'DELETE' });
      if (features.toastEnabled) toast.success('Запчастину видалено');
      onChanged();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка видалення';
      onError?.(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setDeletingPartId(null);
    }
  };

  const canEdit = !disabled;

  return (
    <>
      <div className="bg-surface rounded-xl border border-border p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-foreground">Запчастини та матеріали</h2>
          {canEdit && (
            <div className="flex items-center gap-3">
              <XlsxImportButton
                templateType="wo-parts"
                importUrl={`/xlsx/import/work-order-parts/${woId}`}
                onImportComplete={onChanged}
              />
              <button
                type="button"
                onClick={() => {
                  onError?.('');
                  setPartModal(true);
                }}
                className="text-sm text-primary hover:underline"
              >
                + Запчастина
              </button>
            </div>
          )}
        </div>
        {(parts?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">Запчастини не додані</p>
        ) : (
          <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
            {parts.map(p => (
              <div key={p.id} className="flex items-center justify-between px-4 py-3">
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">{p.goodName}</p>
                  {(p.goodInternalCode || p.goodSku || p.goodBrandName) && (
                    <p className="text-[11px] text-muted-foreground">
                      {[p.goodInternalCode, p.goodSku, p.goodBrandName].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {p.quantity} {p.unitShortName ?? 'шт'} × {fmtMoney(p.price)} ₴
                  </p>
                </div>
                <div className="text-right mr-3">
                  <p className="text-sm font-medium text-foreground">{fmtMoney(p.amount)} ₴</p>
                </div>
                {canEdit && (
                  <button
                    type="button"
                    aria-label="Видалити запчастину"
                    onClick={() => removePart(p.id)}
                    disabled={deletingPartId === p.id}
                    className="text-xs text-destructive/60 hover:text-destructive px-1 disabled:opacity-50"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <WorkOrderAddPartModal
        open={partModal}
        workOrderId={woId}
        warehouses={warehouses}
        initialWarehouseId={initialWarehouseId ?? ''}
        onClose={() => setPartModal(false)}
        onAdded={onChanged}
      />
      <ConfirmDialog {...dialogProps} />
    </>
  );
}
