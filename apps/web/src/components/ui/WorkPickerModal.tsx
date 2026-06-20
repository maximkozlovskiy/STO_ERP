'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '@/lib/api-client';
import { Modal } from './modal';
import { Input } from './input';
import { Spinner } from './spinner';
import { cn } from '@/lib/utils';
import { CategoryTree, collectDescendantIds } from './category-tree';
import type { CategoryNode } from './category-tree';

export interface WorkPickerItem {
  id: string;
  primary: string;
  secondary?: string;
  name: string;
  normoHours: number;
  price: number;
  categoryId: string;
  categoryName?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  selectedId?: string | null;
  onSelect: (item: WorkPickerItem) => void;
}

export function WorkPickerModal({ open, onClose, selectedId, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [selectedCatId, setSelectedCatId] = useState<string | null>(null);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [items, setItems] = useState<WorkPickerItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqRef = useRef(0);

  const categoriesLoadedRef = useRef(false);
  useEffect(() => {
    if (!open || categoriesLoadedRef.current) return;
    categoriesLoadedRef.current = true; // prevent concurrent fetches
    let cancelled = false;
    apiFetch<CategoryNode[] | { items: CategoryNode[] }>('/work-categories')
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
        // allow retry on next open after failure
        if (!cancelled) categoriesLoadedRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const fetchWorks = useCallback(
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
            ids.forEach(id => params.append('categoryIds', id));
          }
          apiFetch<{ items: WorkPickerItem[] }>(`/works?${params}`)
            .then(r => {
              if (reqId !== reqRef.current) return;
              setItems(Array.isArray(r.items) ? r.items : []);
              setLoading(false);
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
      // Bump reqRef so any in-flight /works response is discarded after close
      // (Modal unmounts content via useAnimatedPresence → setState would warn).
      reqRef.current++;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setQuery('');
      setSelectedCatId(null);
      setItems([]);
      setError('');
      setLoading(false);
      return;
    }
    fetchWorks('', null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    fetchWorks(query, selectedCatId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, selectedCatId]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <Modal open={open} onClose={onClose} title="Оберіть роботу" size="lg">
      <div className="flex flex-col gap-3">
        {/* Search */}
        <Input
          placeholder="Пошук роботи..."
          value={query}
          autoFocus
          onChange={e => setQuery(e.target.value)}
        />

        {/* Body: results left + category tree right */}
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
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        onSelect({
                          ...item,
                          primary: item.name,
                          secondary: `${item.normoHours} год · ${item.price} ₴`,
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
                        <span>{item.normoHours} год</span>
                        <span>{item.price} ₴/год</span>
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
            label="Категорії робіт"
            storageKey="sto:cat-tree:work-picker"
            hideInactive
            className="ml-0 border-l rounded-none rounded-r-xl"
          />
        </div>
      </div>
    </Modal>
  );
}
