'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { fmtMoney, fmtDate } from '@/lib/format';

interface StockBatchDto {
  id: string;
  goodId: string;
  warehouseId: string;
  batchNumber: string | null;
  expiryDate: string | null;
  receivedQty: number;
  remainingQty: number;
  costPrice: number;
  salePrice: number;
  isActive: boolean;
  createdAt: string;
  purchaseOrderNumber: string | null;
  purchaseOrderLineId: string | null;
  unitOfMeasureId: string | null;
  unitShortName: string | null;
}

interface GoodBatchesTabProps {
  goodId: string;
  /** Notifies parent when active-batches count changes (for tabs strip badge) */
  onCountChange?: (count: number) => void;
}

export function GoodBatchesTab({ goodId, onCountChange }: GoodBatchesTabProps) {
  const [modalBatches, setModalBatches] = useState<StockBatchDto[]>([]);
  const [modalBatchesLoading, setModalBatchesLoading] = useState(false);
  const [batchError, setBatchError] = useState('');
  const modalBatchReqRef = useRef(0);

  // Notify parent — count of active batches (remainingQty > 0) for tab badge.
  useEffect(() => {
    onCountChange?.(modalBatches.filter(b => b.remainingQty > 0).length);
  }, [modalBatches, onCountChange]);

  useEffect(() => {
    if (!goodId) {
      setModalBatches([]);
      return;
    }
    const reqId = ++modalBatchReqRef.current;
    setModalBatches([]);
    setModalBatchesLoading(true);
    setBatchError('');

    apiFetch<{ items: StockBatchDto[]; total: number }>(`/goods/${goodId}/batches`)
      .then(data => {
        if (modalBatchReqRef.current === reqId) setModalBatches(data.items);
      })
      .catch(err => {
        if (modalBatchReqRef.current === reqId)
          setBatchError(err instanceof Error ? err.message : 'Помилка завантаження партій');
      })
      .finally(() => {
        if (modalBatchReqRef.current === reqId) setModalBatchesLoading(false);
      });
  }, [goodId]);

  return (
    <div className="space-y-3">
      {modalBatchesLoading && (
        <div className="py-6 text-center text-sm text-muted-foreground">Завантаження...</div>
      )}
      {!modalBatchesLoading && batchError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
          {batchError}
        </div>
      )}
      {!modalBatchesLoading && !batchError && modalBatches.length === 0 && (
        <p className="text-[13px] text-muted-foreground text-center py-4">Партій немає</p>
      )}
      {!modalBatchesLoading && !batchError && modalBatches.length > 0 && (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="bg-secondary border-b border-border">
              <tr>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                  Партія / Накладна
                </th>
                <th className="text-right px-3 py-2 text-muted-foreground font-medium">Отримано</th>
                <th className="text-right px-3 py-2 text-muted-foreground font-medium">Залишок</th>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Одиниця</th>
                <th className="text-right px-3 py-2 text-muted-foreground font-medium">
                  Собів., ₴
                </th>
                <th className="text-right px-3 py-2 text-muted-foreground font-medium">
                  Продаж, ₴
                </th>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Дата</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {modalBatches.map(b => (
                <tr key={b.id} className="bg-surface hover:bg-secondary/50 transition-colors">
                  <td className="px-3 py-2 text-foreground">
                    {b.batchNumber ?? b.purchaseOrderNumber ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                    {b.receivedQty}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {b.remainingQty > 0 ? (
                      <span className="text-foreground">{b.remainingQty}</span>
                    ) : (
                      <span className="text-muted-foreground line-through">{b.remainingQty}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground text-[12px]">
                    {b.unitShortName ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                    {fmtMoney(b.costPrice)}
                  </td>
                  <td className="px-3 py-2 text-right text-foreground tabular-nums">
                    {fmtMoney(b.salePrice)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{fmtDate(b.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
