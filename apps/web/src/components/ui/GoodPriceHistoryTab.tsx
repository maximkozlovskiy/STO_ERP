'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { fmtMoney, fmtDateTime } from '@/lib/format';
import { Spinner } from '@/components/ui/spinner';

interface PriceHistoryEntry {
  id: string;
  oldPrice: number | null;
  newPrice: number;
  costPrice: number | null;
  reason: string | null;
  createdAt: string;
}

interface GoodPriceHistoryTabProps {
  goodId: string;
  onCountChange?: (count: number) => void;
}

export function GoodPriceHistoryTab({ goodId, onCountChange }: GoodPriceHistoryTabProps) {
  const [items, setItems] = useState<PriceHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<{ items: PriceHistoryEntry[]; total: number }>(`/goods/${goodId}/price-history`)
      .then(res => {
        if (cancelled) return;
        setItems(res.items);
        onCountChange?.(res.total);
      })
      .catch((err: unknown) => {
        // §8.2: don't silently swallow fetch errors — surface to console for diagnostics.
        // Tab UI keeps empty state (acceptable for read-only history view), but devs see the failure.
        if (!cancelled) console.error('[GoodPriceHistoryTab] fetch failed', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [goodId, onCountChange]);

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="sm" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground text-center py-6">Змін цін не знайдено</p>
    );
  }

  return (
    <div className="overflow-auto">
      <table className="w-full text-[13px]">
        <colgroup>
          <col className="w-40" />
          <col className="w-28" />
          <col className="w-28" />
          <col className="w-28" />
          <col />
        </colgroup>
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2 px-2 text-[11px] font-medium text-muted-foreground">
              Дата
            </th>
            <th className="text-right py-2 px-2 text-[11px] font-medium text-muted-foreground">
              Стара ціна
            </th>
            <th className="text-right py-2 px-2 text-[11px] font-medium text-muted-foreground">
              Нова ціна
            </th>
            <th className="text-right py-2 px-2 text-[11px] font-medium text-muted-foreground">
              Собівартість
            </th>
            <th className="text-left py-2 px-2 text-[11px] font-medium text-muted-foreground">
              Причина
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map(h => (
            <tr key={h.id} className="border-b border-border/50 hover:bg-secondary/30">
              <td className="py-2 px-2 text-muted-foreground tabular-nums">
                {fmtDateTime(h.createdAt)}
              </td>
              <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">
                {h.oldPrice != null ? `${fmtMoney(h.oldPrice)} ₴` : '—'}
              </td>
              <td className="py-2 px-2 text-right tabular-nums font-medium">
                {fmtMoney(h.newPrice)} ₴
              </td>
              <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">
                {h.costPrice != null ? `${fmtMoney(h.costPrice)} ₴` : '—'}
              </td>
              <td className="py-2 px-2 text-muted-foreground truncate max-w-[180px]">
                {h.reason ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
