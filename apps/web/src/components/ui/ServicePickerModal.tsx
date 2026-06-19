'use client';

import { useState, useEffect, useRef } from 'react';
import { apiFetch } from '@/lib/api-client';
import { Modal } from './modal';
import { Input } from './input';
import { Spinner } from './spinner';
import { cn } from '@/lib/utils';
import { fmtMoney } from '@/lib/format';

export interface ServicePickerItem {
  id: string;
  name: string;
  description: string | null;
  price: number | null;
  works: Array<{
    workId: string;
    workName: string;
    normoHours: number;
    price: number;
    quantity: number;
  }>;
  goods: Array<{
    goodId: string;
    goodName: string;
    unit: string;
    salePrice: number;
    quantity: number;
  }>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (item: ServicePickerItem) => void;
}

export function ServicePickerModal({ open, onClose, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ServicePickerItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqRef = useRef(0);

  useEffect(() => {
    if (!open) {
      reqRef.current++;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setQuery('');
      setItems([]);
      setError('');
      setLoading(false);
      return;
    }
    fetch('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    fetch(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function fetch(q: string) {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    const reqId = ++reqRef.current;
    setLoading(true);
    setError('');
    timeoutRef.current = setTimeout(
      () => {
        const params = new URLSearchParams({ limit: '50' });
        if (q) params.set('q', q);
        apiFetch<{ items: ServicePickerItem[] }>(`/services?${params}`)
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
  }

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <Modal open={open} onClose={onClose} title="Оберіть комплексну послугу" size="lg">
      <div className="flex flex-col gap-3">
        <Input
          placeholder="Пошук послуги..."
          value={query}
          autoFocus
          onChange={e => setQuery(e.target.value)}
        />
        <div className="overflow-y-auto" style={{ height: '420px' }}>
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
              {items.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onSelect(item);
                    onClose();
                  }}
                  className={cn(
                    'w-full text-left px-3 py-2.5 rounded-lg border border-border bg-surface hover:border-primary hover:bg-primary/5 transition-colors',
                  )}
                >
                  <div className="text-sm font-medium text-foreground">{item.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5 flex gap-3 flex-wrap">
                    {item.works.length > 0 && <span>{item.works.length} роб.</span>}
                    {item.goods.length > 0 && <span>{item.goods.length} тов.</span>}
                    {item.price != null && <span>{fmtMoney(item.price)} ₴</span>}
                    {item.description && (
                      <span className="truncate max-w-[200px]">{item.description}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
