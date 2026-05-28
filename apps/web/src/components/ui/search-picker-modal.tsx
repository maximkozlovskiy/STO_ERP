'use client';

import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { Modal } from './modal';
import { Input } from './input';
import { Spinner } from './spinner';
import { cn } from '@/lib/utils';

export interface SearchPickerItem {
  id: string;
  primary: string;
  secondary?: string;
}

interface SearchPickerModalProps<T extends SearchPickerItem> {
  open: boolean;
  onClose: () => void;
  title: string;
  selectedId?: string | null;
  onSelect: (item: T) => void;
  fetchItems: (q: string) => Promise<T[]>;
  searchPlaceholder?: string;
  emptyText?: string;
  renderItem?: (item: T, selected: boolean) => ReactNode;
}

export function SearchPickerModal<T extends SearchPickerItem>({
  open,
  onClose,
  title,
  selectedId,
  onSelect,
  fetchItems,
  searchPlaceholder = 'Пошук...',
  emptyText = 'Нічого не знайдено',
  renderItem,
}: SearchPickerModalProps<T>) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Load initial list when modal opens
  useEffect(() => {
    if (!open) { setQuery(''); setItems([]); return; }
    setLoading(true);
    fetchItems('').then(data => {
      if (mountedRef.current) setItems(data);
    }).catch(() => {}).finally(() => {
      if (mountedRef.current) setLoading(false);
    });
  }, [open, fetchItems]);

  const search = useCallback((q: string) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setLoading(true);
    timeoutRef.current = setTimeout(() => {
      fetchItems(q).then(data => {
        if (mountedRef.current) { setItems(data); setLoading(false); }
      }).catch(() => { if (mountedRef.current) setLoading(false); });
    }, 300);
  }, [fetchItems]);

  useEffect(() => {
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, []);

  const handleClose = useCallback(() => {
    setQuery(''); setItems([]);
    onClose();
  }, [onClose]);

  return (
    <Modal open={open} onClose={handleClose} title={title} size="md">
      <div className="space-y-3">
        <Input
          placeholder={searchPlaceholder}
          value={query}
          autoFocus
          onChange={e => {
            setQuery(e.target.value);
            search(e.target.value);
          }}
        />
        {loading ? (
          <div className="flex justify-center py-6"><Spinner size="sm" /></div>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">{emptyText}</p>
        ) : (
          <div className="space-y-1 max-h-96 overflow-y-auto pr-0.5">
            {items.map(item => {
              const selected = item.id === selectedId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => { onSelect(item); handleClose(); }}
                  className={cn(
                    'w-full text-left px-3 py-2.5 rounded-lg border transition-colors',
                    selected
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-surface hover:border-primary hover:bg-primary/5'
                  )}
                >
                  {renderItem ? renderItem(item, selected) : (
                    <div>
                      <div className="text-sm font-medium text-foreground">{item.primary}</div>
                      {item.secondary && <div className="text-xs text-muted-foreground mt-0.5">{item.secondary}</div>}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
