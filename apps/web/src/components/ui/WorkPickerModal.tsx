'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '@/lib/api-client';
import { Modal } from './modal';
import { Input } from './input';
import { Spinner } from './spinner';
import { cn } from '@/lib/utils';

interface WorkCategory {
  id: string;
  name: string;
}

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
  const [categoryId, setCategoryId] = useState('');
  const [categories, setCategories] = useState<WorkCategory[]>([]);
  const [items, setItems] = useState<WorkPickerItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqRef = useRef(0);

  const categoriesLoadedRef = useRef(false);
  useEffect(() => {
    if (!open || categoriesLoadedRef.current) return;
    categoriesLoadedRef.current = true;
    apiFetch<{ items: WorkCategory[] }>('/work-categories?limit=100')
      .then(r => setCategories(Array.isArray(r.items) ? r.items : []))
      .catch(() => {});
  }, [open]);

  const fetchWorks = useCallback((q: string, catId: string) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    const reqId = ++reqRef.current;
    setLoading(true);
    setError('');
    timeoutRef.current = setTimeout(
      () => {
        const params = new URLSearchParams({ limit: '50' });
        if (q) params.set('q', q);
        if (catId) params.set('categoryId', catId);
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
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setCategoryId('');
      setItems([]);
      setError('');
      return;
    }
    fetchWorks('', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    fetchWorks(query, categoryId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, categoryId]);

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

        {/* Body: results left + categories right */}
        <div className="flex gap-3 min-h-0" style={{ height: '420px' }}>
          {/* Results */}
          <div className="flex-1 overflow-y-auto">
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
              <div className="space-y-1 pr-1">
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

          {/* Category sidebar */}
          <div className="w-44 shrink-0 border-l border-border overflow-y-auto pl-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted mb-2">
              Категорія
            </p>
            <div className="space-y-0.5">
              <button
                type="button"
                onClick={() => setCategoryId('')}
                className={cn(
                  'w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors',
                  categoryId === ''
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-foreground hover:bg-secondary',
                )}
              >
                Всі категорії
              </button>
              {categories.map(c => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCategoryId(c.id)}
                  className={cn(
                    'w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors',
                    categoryId === c.id
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-foreground hover:bg-secondary',
                  )}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
