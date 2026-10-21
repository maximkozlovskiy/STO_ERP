import { useState, useMemo, useEffect } from 'react';
import { apiFetch } from '@/lib/api-client';
import { freeOf, type StockByWarehouseRow, type WarehouseFree } from '@/lib/part-warehouse';

/**
 * A3-modal: stock-totals кеш для parts-таблиці, винесений з CreateWorkOrderModal.
 * Тягне залишки (загальний + per-warehouse) для набору goodId-ів з parts/newPart/editingPart.
 *
 * Load-bearing поведінка (Bug #452/#453/#454), збережена ДОСЛІВНО:
 *  - #453 dedup goodId-ів через Set;
 *  - #454 стабільний sort ключа → reorder parts не тригерить refetch;
 *  - #452 порожній набір → НЕ б'є /goods/stock-totals (early-return з очищенням мап);
 *  - #454 fetch-error лише console.error, НЕ throw (форма не блокується);
 *  - re-fetch ЛИШЕ коли змінюється НАБІР goodId-ів (не на кожен keystroke qty/price).
 *
 * BR-WO-029: `stockFreeByGood` — вільна кількість (`available`) по складах для кожного запитаного
 * товару; запис є для КОЖНОГО goodId останньої відповіді (порожній масив — залишків немає), тож
 * «запис є» = «залишки цього товару отримано» (автовибір складу чекає саме на це). Запит упав →
 * товарам без запису ставиться `null`: підписи складів без кількості, автовибір — як «вільної
 * немає» (основний склад), а не порожнє поле назавжди.
 */
export interface StockTotals {
  stockTotalsMap: Map<string, number>;
  stockWarehouseMap: Map<string, number>;
  stockFreeByGood: Map<string, WarehouseFree[] | null>;
}

export function useStockTotals(
  parts: { goodId: string }[],
  newPartGoodId: string,
  editingPartGoodId: string,
): StockTotals {
  const [stockTotalsMap, setStockTotalsMap] = useState<Map<string, number>>(new Map());
  // key = `${goodId}:${warehouseId}` → quantity on that specific warehouse
  const [stockWarehouseMap, setStockWarehouseMap] = useState<Map<string, number>>(new Map());
  const [stockFreeByGood, setStockFreeByGood] = useState<Map<string, WarehouseFree[] | null>>(
    new Map(),
  );

  // derive a *stable string key* from the set of goodId-s. The previous
  // dep array re-fired the effect on ANY parts mutation — including typing in
  // quantity/price — issuing a fresh /goods/stock-totals request per keystroke even
  // when the set of goods had not changed. We memoize a sorted-comma-joined fingerprint
  // so the effect re-runs ONLY when the actual set of goodIds changes.
  const stockGoodIdsKey = useMemo(() => {
    const ids = new Set<string>();
    for (const p of parts) if (p.goodId) ids.add(p.goodId);
    if (newPartGoodId) ids.add(newPartGoodId);
    if (editingPartGoodId) ids.add(editingPartGoodId);
    // Sort for stability — Set iteration order is insertion-based, but reordering
    // parts (move/delete + re-add) would yield a different key while the *set*
    // is unchanged. Sorting kills that false positive.
    return [...ids].sort().join(',');
  }, [parts, newPartGoodId, editingPartGoodId]);

  useEffect(() => {
    if (!stockGoodIdsKey) {
      setStockTotalsMap(new Map());
      setStockWarehouseMap(new Map());
      setStockFreeByGood(new Map());
      return;
    }
    const goodIds = stockGoodIdsKey.split(',');
    let cancelled = false;
    void apiFetch<
      {
        goodId: string;
        totalQuantity: number;
        byWarehouse?: StockByWarehouseRow[];
      }[]
    >(`/goods/stock-totals?ids=${stockGoodIdsKey}`)
      .then(rows => {
        if (cancelled) return;
        const nextTotals = new Map<string, number>(goodIds.map(id => [id, 0]));
        const nextWh = new Map<string, number>();
        const nextFree = new Map<string, WarehouseFree[] | null>(goodIds.map(id => [id, []]));
        for (const r of rows) {
          nextTotals.set(r.goodId, r.totalQuantity);
          const free: WarehouseFree[] = [];
          for (const w of r.byWarehouse ?? []) {
            nextWh.set(`${r.goodId}:${w.warehouseId}`, w.quantity);
            free.push({ warehouseId: w.warehouseId, available: freeOf(w) });
          }
          nextFree.set(r.goodId, free);
        }
        setStockTotalsMap(nextTotals);
        setStockWarehouseMap(nextWh);
        setStockFreeByGood(nextFree);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('[stock-totals] fetch failed', err);
        setStockFreeByGood(prev => {
          const next = new Map(prev);
          for (const id of goodIds) if (!next.has(id)) next.set(id, null);
          return next;
        });
      });
    return () => {
      cancelled = true;
    };
  }, [stockGoodIdsKey]);

  return { stockTotalsMap, stockWarehouseMap, stockFreeByGood };
}
