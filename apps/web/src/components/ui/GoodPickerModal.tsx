'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '@/lib/api-client';
import { Modal } from './modal';
import { Input } from './input';
import { Spinner } from './spinner';
import { cn } from '@/lib/utils';
import { CategoryTree, collectDescendantIds } from './category-tree';
import type { CategoryNode } from './category-tree';

export interface GoodPickerItem {
  id: string;
  primary: string;
  secondary?: string;
  name: string;
  sku?: string | null;
  salePrice: number;
  category?: string | null;
  unitId?: string | null;
  unitShortName?: string | null;
}

interface StockTotal {
  goodId: string;
  totalQuantity: number;
}

// sto-optimize: module-level stable refs — `new Map()` всередині `setStockMap(new Map())`
// alloc-ився на кожному close-/no-results- виклику. Тепер shared empty ref.
const EMPTY_STOCK_MAP: Map<string, number> = new Map();

interface Props {
  open: boolean;
  onClose: () => void;
  selectedId?: string | null;
  onSelect: (item: GoodPickerItem) => void;
}

export function GoodPickerModal({ open, onClose, selectedId, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [selectedCatId, setSelectedCatId] = useState<string | null>(null);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [items, setItems] = useState<GoodPickerItem[]>([]);
  const [stockMap, setStockMap] = useState<Map<string, number>>(EMPTY_STOCK_MAP);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqRef = useRef(0);

  const categoriesLoadedRef = useRef(false);
  useEffect(() => {
    if (!open || categoriesLoadedRef.current) return;
    categoriesLoadedRef.current = true; // prevent concurrent fetches
    let cancelled = false;
    apiFetch<CategoryNode[] | { items: CategoryNode[] }>('/good-categories')
      .then(r => {
        if (cancelled) return;
        // Tolerate both array-of-categories and { items, total } envelope
        const arr = Array.isArray(r)
          ? r
          : Array.isArray((r as { items?: CategoryNode[] }).items)
            ? (r as { items: CategoryNode[] }).items
            : [];
        setCategories(arr);
      })
      .catch(() => {
        // Bug #387: allow retry on next open after failure
        if (!cancelled) categoriesLoadedRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const fetchGoods = useCallback(
    (q: string, catId: string | null) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      const reqId = ++reqRef.current;
      setLoading(true);
      setError('');
      timeoutRef.current = setTimeout(
        () => {
          const params = new URLSearchParams({ limit: '50' });
          if (q) params.set('q', q);
          if (catId) {
            const ids = collectDescendantIds(categories, catId);
            ids.forEach(id => params.append('goodCategoryIds', id));
          }
          // /goods і /goods/stock-totals sequential — stock-totals потребує ids з
          // response /goods. sto-optimize: shared EMPTY_STOCK_MAP замість `new Map()`
          // на кожному 0-results call → стабільна reference (re-render skip downstream).
          apiFetch<{
            items: (Omit<GoodPickerItem, 'unitShortName'> & { unit?: string | null })[];
          }>(`/goods?${params}`)
            .then(r => {
              if (reqId !== reqRef.current) return;
              const goods = (Array.isArray(r.items) ? r.items : []).map(g => ({
                ...g,
                unitShortName: g.unit ?? null,
              }));
              setItems(goods);
              setLoading(false);
              // Fetch stock totals for the loaded goods batch
              if (goods.length > 0) {
                const ids = goods.map(g => g.id).join(',');
                apiFetch<StockTotal[]>(`/goods/stock-totals?ids=${ids}`)
                  .then(totals => {
                    if (reqId !== reqRef.current) return;
                    setStockMap(new Map(totals.map(t => [t.goodId, t.totalQuantity])));
                  })
                  .catch(() => {
                    /* non-critical — залишки не показуємо якщо помилка */
                  });
              } else {
                setStockMap(EMPTY_STOCK_MAP);
              }
            })
            .catch((e: unknown) => {
              if (reqId !== reqRef.current) return;
              setError(e instanceof Error ? e.message : 'Помилка завантаження');
              setLoading(false);
            });
        },
        q ? 300 : 0,
      );
    },
    [categories],
  );

  useEffect(() => {
    if (!open) {
      // Bump reqRef so any in-flight /goods response is discarded after close
      // (Modal unmounts content via useAnimatedPresence → setState would warn).
      reqRef.current++;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setQuery('');
      setSelectedCatId(null);
      setItems([]);
      setStockMap(EMPTY_STOCK_MAP);
      setError('');
      setLoading(false);
      return;
    }
    fetchGoods('', null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    fetchGoods(query, selectedCatId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, selectedCatId]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <Modal open={open} onClose={onClose} title="Оберіть товар" size="lg">
      <div className="flex flex-col gap-3">
        <Input
          placeholder="Пошук товару..."
          value={query}
          autoFocus
          onChange={e => setQuery(e.target.value)}
        />

        <div className="flex gap-0 min-h-0" style={{ height: '420px' }}>
          {/* Results */}
          <div className="flex-1 overflow-y-auto pr-3">
            {error && (
              <p className="text-sm text-destructive-text bg-destructive-subtle border border-destructive/20 rounded-lg px-3 py-2 mb-2">
                {error}
              </p>
            )}
            {loading ? (
              <div className="flex justify-center py-10">
                <Spinner size="sm" />
              </div>
            ) : items.length === 0 ? (
              <p className="text-sm text-muted-foreground py-10 text-center">Нічого не знайдено</p>
            ) : (
              <div className="space-y-1">
                {items.map(item => {
                  const selected = item.id === selectedId;
                  // sto-optimize: підняти qty lookup з IIFE у тілі JSX — раніше
                  // `(() => { const qty = stockMap.get(item.id) ?? 0; return <span>... })()`
                  // створював нову arrow на кожен render для КОЖНОГО row.
                  const qty = stockMap.get(item.id) ?? 0;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        onSelect({
                          ...item,
                          primary: item.name,
                          secondary: item.sku
                            ? `${item.sku} · ${item.salePrice} ₴`
                            : `${item.salePrice} ₴`,
                        });
                        onClose();
                      }}
                      className={cn(
                        'w-full text-left px-3 py-2 rounded-lg border transition-colors',
                        selected
                          ? 'border-primary bg-primary/5'
                          : 'border-border bg-surface hover:border-primary hover:bg-primary/5',
                      )}
                    >
                      <div className="text-sm font-medium text-foreground">{item.name}</div>
                      <div className="text-xs text-muted-foreground mt-0.5 flex gap-3">
                        {item.sku && <span>{item.sku}</span>}
                        <span>{item.salePrice} ₴</span>
                        <span className={qty > 0 ? 'text-success' : 'text-destructive-text'}>
                          {qty > 0 ? `${qty} на складі` : 'немає на складі'}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Category tree sidebar */}
          <CategoryTree
            tree={categories}
            selectedId={selectedCatId}
            onSelect={setSelectedCatId}
            label="Категорії товарів"
            storageKey="sto:cat-tree:good-picker"
            hideInactive
            className="ml-0 border-l rounded-none rounded-r-xl"
          />
        </div>
      </div>
    </Modal>
  );
}
