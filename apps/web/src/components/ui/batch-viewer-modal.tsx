'use client';

import { useState, useEffect, useCallback } from 'react';
import { Package, TrendingUp, X, ChevronDown, ChevronUp } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface BatchItem {
  id: string;
  batchNumber: string | null;
  receivedQty: number;
  remainingQty: number;
  costPrice: number;
  salePrice: number;
  expiryDate: string | null;
  isActive: boolean;
  createdAt: string;
  purchaseOrderNumber: string | null;
}

interface PriceHistoryItem {
  id: string;
  oldPrice: number | null;
  newPrice: number;
  costPrice: number | null;
  reason: string | null;
  createdAt: string;
}

interface BatchLookupResult {
  good: { id: string; name: string; sku: string | null; unit: string; salePrice: number };
  avgCostPrice: number;
  batches: BatchItem[];
  priceHistory: PriceHistoryItem[];
}

interface BatchViewerModalProps {
  goodId: string;
  warehouseId?: string;
  open: boolean;
  onClose: () => void;
}

function fmt(n: number) {
  return n.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString('uk-UA');
}

function margin(sale: number, cost: number) {
  if (!cost) return null;
  return ((sale - cost) / sale * 100).toFixed(1);
}

export function BatchViewerModal({ goodId, warehouseId, open, onClose }: BatchViewerModalProps) {
  const [tab, setTab] = useState<'batches' | 'history'>('batches');
  const [data, setData] = useState<BatchLookupResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ goodId });
      if (warehouseId) params.set('warehouseId', warehouseId);
      const result = await apiFetch<BatchLookupResult>(`/batches/lookup?${params}`);
      setData(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження');
    } finally {
      setLoading(false);
    }
  }, [goodId, warehouseId]);

  useEffect(() => {
    if (open && goodId) load();
  }, [open, goodId, load]);

  if (!open) return null;

  const activeBatches = data?.batches.filter(b => b.isActive && b.remainingQty > 0) ?? [];
  const depletedBatches = data?.batches.filter(b => !b.isActive || b.remainingQty <= 0) ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-surface border border-border rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b border-border">
          <div>
            <h2 className="text-[15px] font-semibold text-foreground">Партії та ціни</h2>
            {data && (
              <p className="text-[13px] text-muted-foreground mt-0.5">
                {data.good.name}
                {data.good.sku && <span className="ml-1 text-muted-foreground/70">({data.good.sku})</span>}
              </p>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-secondary text-muted-foreground transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Summary bar */}
        {data && (
          <div className="flex gap-4 px-4 py-2.5 bg-secondary/40 border-b border-border text-[12px]">
            <div>
              <span className="text-muted-foreground">Поточна ціна:&nbsp;</span>
              <span className="font-semibold text-foreground">{fmt(data.good.salePrice)} ₴</span>
            </div>
            <div>
              <span className="text-muted-foreground">Сер. собівартість:&nbsp;</span>
              <span className="font-semibold text-foreground">{fmt(data.avgCostPrice)} ₴</span>
            </div>
            {data.avgCostPrice > 0 && (
              <div>
                <span className="text-muted-foreground">Маржа:&nbsp;</span>
                <span className="font-semibold text-success">
                  {margin(data.good.salePrice, data.avgCostPrice)}%
                </span>
              </div>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-border px-4">
          {(['batches', 'history'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'py-2.5 px-3 text-[13px] font-medium border-b-2 transition-colors -mb-px',
                tab === t
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t === 'batches' ? (
                <span className="flex items-center gap-1.5"><Package className="h-3.5 w-3.5" /> Партії</span>
              ) : (
                <span className="flex items-center gap-1.5"><TrendingUp className="h-3.5 w-3.5" /> Історія цін</span>
              )}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 p-4">
          {loading && (
            <div className="flex justify-center py-8">
              <div className="h-6 w-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {error && <p className="text-[13px] text-destructive">{error}</p>}

          {!loading && !error && data && tab === 'batches' && (
            <div className="space-y-3">
              {/* Active batches */}
              {activeBatches.length === 0 && depletedBatches.length === 0 && (
                <p className="text-[13px] text-muted-foreground text-center py-6">Партії відсутні</p>
              )}
              {activeBatches.map(b => (
                <BatchRow
                  key={b.id}
                  batch={b}
                  expanded={expandedId === b.id}
                  onToggle={() => setExpandedId(expandedId === b.id ? null : b.id)}
                />
              ))}
              {/* Depleted batches */}
              {depletedBatches.length > 0 && (
                <div className="mt-4">
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">Вичерпані партії</p>
                  {depletedBatches.map(b => (
                    <BatchRow
                      key={b.id}
                      batch={b}
                      expanded={expandedId === b.id}
                      onToggle={() => setExpandedId(expandedId === b.id ? null : b.id)}
                      depleted
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {!loading && !error && data && tab === 'history' && (
            <div className="space-y-1">
              {data.priceHistory.length === 0 && (
                <p className="text-[13px] text-muted-foreground text-center py-6">Змін ціни не було</p>
              )}
              {data.priceHistory.map(h => (
                <div key={h.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div>
                    <div className="flex items-center gap-2 text-[13px]">
                      {h.oldPrice != null && (
                        <span className="text-muted-foreground line-through">{fmt(h.oldPrice)} ₴</span>
                      )}
                      <span className="font-medium text-foreground">{fmt(h.newPrice)} ₴</span>
                      {h.costPrice != null && (
                        <span className="text-[11px] text-muted-foreground">
                          (собів. {fmt(h.costPrice)} ₴)
                        </span>
                      )}
                    </div>
                    {h.reason && <p className="text-[11px] text-muted-foreground mt-0.5">{h.reason}</p>}
                  </div>
                  <span className="text-[11px] text-muted-foreground shrink-0 ml-4">{fmtDate(h.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BatchRow({
  batch,
  expanded,
  onToggle,
  depleted = false,
}: {
  batch: BatchItem;
  expanded: boolean;
  onToggle: () => void;
  depleted?: boolean;
}) {
  const pct = batch.receivedQty > 0
    ? Math.round((batch.remainingQty / batch.receivedQty) * 100)
    : 0;

  return (
    <div className={cn(
      'border border-border rounded-lg overflow-hidden',
      depleted && 'opacity-50',
    )}>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-secondary/50 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className={cn(
            'h-2 w-2 rounded-full shrink-0',
            depleted ? 'bg-muted-foreground' : 'bg-success',
          )} />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground truncate">
              {batch.purchaseOrderNumber ? `Накладна ${batch.purchaseOrderNumber}` : 'Ручна партія'}
              {batch.batchNumber && <span className="ml-1 text-muted-foreground">№{batch.batchNumber}</span>}
            </p>
            <p className="text-[11px] text-muted-foreground">{fmtDate(batch.createdAt)}</p>
          </div>
        </div>
        <div className="flex items-center gap-4 shrink-0 ml-3">
          <div className="text-right">
            <p className="text-[13px] font-semibold text-foreground">
              {batch.remainingQty} / {batch.receivedQty}
            </p>
            <p className="text-[11px] text-muted-foreground">{pct}% залишок</p>
          </div>
          <div className="text-right">
            <p className="text-[13px] font-medium text-foreground">{fmt(batch.salePrice)} ₴</p>
            <p className="text-[11px] text-muted-foreground">продаж</p>
          </div>
          {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 bg-secondary/20 border-t border-border grid grid-cols-3 gap-3 text-[12px]">
          <div>
            <p className="text-muted-foreground">Собівартість</p>
            <p className="font-medium text-foreground">{fmt(batch.costPrice)} ₴</p>
          </div>
          <div>
            <p className="text-muted-foreground">Ціна продажу</p>
            <p className="font-medium text-foreground">{fmt(batch.salePrice)} ₴</p>
          </div>
          <div>
            <p className="text-muted-foreground">Маржа</p>
            <p className="font-medium text-success">{margin(batch.salePrice, batch.costPrice) ?? '—'}%</p>
          </div>
          {batch.expiryDate && (
            <div>
              <p className="text-muted-foreground">Термін придатності</p>
              <p className="font-medium text-foreground">{fmtDate(batch.expiryDate)}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
