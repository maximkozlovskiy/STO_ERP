'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { cn } from '@/lib/utils';
import { fmtMoney } from '@/lib/format';
import { WorkOrderAddLineModal } from '@/components/ui/WorkOrderAddLineModal';

interface WorkOrderLine {
  id: string;
  workOrderId?: string;
  workId: string;
  workName?: string;
  employeeId: string;
  employeeName?: string;
  liftId?: string | null;
  normoHours: number;
  actualHours?: number | null;
  price: number;
  amount: number;
  notes?: string | null;
  createdAt?: string;
}

interface Work {
  id: string;
  name: string;
  normoHours: number;
  price: number;
}

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
}

interface WorkOrderLinesSectionProps {
  woId: string;
  lines: WorkOrderLine[];
  /** Reserved for future tenant-scoped endpoints. */
  orgId?: string;
  /** Reference data — passed down to AddLineModal. */
  works: Work[];
  employees: Employee[];
  /** Reload parent state after add/delete. */
  onChanged: () => void;
  /** Locks add/delete when WO status is non-editable. */
  disabled?: boolean;
  /** Surface delete errors at the page level (preserves original UX). */
  onError?: (msg: string) => void;
}

export function WorkOrderLinesSection({
  woId,
  lines,
  works,
  employees,
  onChanged,
  disabled,
  onError,
}: WorkOrderLinesSectionProps) {
  const features = useUiFeatures();
  const { confirm, dialogProps } = useConfirm();
  const [lineModal, setLineModal] = useState(false);
  const [deletingLineId, setDeletingLineId] = useState<string | null>(null);

  const removeLine = async (lineId: string) => {
    if (!(await confirm({ title: 'Видалити роботу?', variant: 'destructive' }))) return;
    setDeletingLineId(lineId);
    onError?.('');
    try {
      await apiFetch<void>(`/work-orders/${woId}/lines/${lineId}`, { method: 'DELETE' });
      if (features.toastEnabled) toast.success('Роботу видалено');
      onChanged();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка видалення';
      onError?.(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setDeletingLineId(null);
    }
  };

  const canEdit = !disabled;

  return (
    <>
      <div className="bg-surface rounded-xl border border-border p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-foreground">Роботи</h2>
          {canEdit && (
            <button
              onClick={() => {
                onError?.('');
                setLineModal(true);
              }}
              className="text-sm text-primary hover:underline"
            >
              + Робота
            </button>
          )}
        </div>
        {(lines?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">Роботи не додані</p>
        ) : (
          <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
            {lines.map(l => (
              <div key={l.id} className="flex items-center justify-between px-4 py-3">
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">{l.workName}</p>
                  <p className="text-xs text-muted-foreground">
                    {l.employeeName} · <span>{l.normoHours} н/г норм.</span>
                    {l.actualHours != null && (
                      <span
                        className={cn(
                          'ml-1',
                          l.actualHours > l.normoHours
                            ? 'text-warning font-medium'
                            : 'text-muted-foreground/70',
                        )}
                      >
                        {l.actualHours} н/г факт.
                      </span>
                    )}
                  </p>
                  {l.notes && <p className="text-xs text-muted-foreground mt-0.5">{l.notes}</p>}
                </div>
                <div className="text-right mr-3">
                  <p className="text-sm font-medium text-foreground">{fmtMoney(l.amount)} ₴</p>
                  <p className="text-xs text-muted-foreground">
                    {fmtMoney(l.price)} × {l.normoHours}
                  </p>
                </div>
                {canEdit && (
                  <button
                    onClick={() => removeLine(l.id)}
                    disabled={deletingLineId === l.id}
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

      <WorkOrderAddLineModal
        open={lineModal}
        workOrderId={woId}
        works={works}
        employees={employees}
        onClose={() => setLineModal(false)}
        onAdded={onChanged}
      />
      <ConfirmDialog {...dialogProps} />
    </>
  );
}
