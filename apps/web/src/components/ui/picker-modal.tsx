'use client';
import { useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { Modal } from './modal';
import { Input } from './input';
import { cn } from '@/lib/utils';

export interface PickerItem {
  id: string;
}

interface PickerModalProps<T extends PickerItem> {
  open: boolean;
  onClose: () => void;
  title: string;
  items: T[];
  selectedId?: string | null;
  onSelect: (item: T) => void;
  /** Fields to search in — strings and nullables supported */
  searchKeys: string[];
  /** Render the content of each list row */
  renderItem: (item: T, selected: boolean) => ReactNode;
  searchPlaceholder?: string;
  emptyText?: string;
  emptySearchText?: string;
}

export function PickerModal<T extends PickerItem>({
  open,
  onClose,
  title,
  items,
  selectedId,
  onSelect,
  searchKeys,
  renderItem,
  searchPlaceholder = 'Пошук...',
  emptyText = 'Список порожній',
  emptySearchText = 'Нічого не знайдено',
}: PickerModalProps<T>) {
  const [query, setQuery] = useState('');

  const handleClose = useCallback(() => {
    setQuery('');
    onClose();
  }, [onClose]);

  const trimmed = query.trim();
  const filtered = trimmed
    ? items.filter(item =>
        searchKeys.some(k => {
          const v = (item as Record<string, unknown>)[k];
          return typeof v === 'string' && v.toLowerCase().includes(trimmed.toLowerCase());
        }),
      )
    : items;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={title}
      footer={
        <button
          type="button"
          onClick={handleClose}
          className="px-4 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-surface-hover transition-colors"
        >
          Закрити
        </button>
      }
    >
      <div className="space-y-3">
        <Input
          placeholder={searchPlaceholder}
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
        />
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">{emptyText}</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">{emptySearchText}</p>
        ) : (
          <div className="space-y-1 max-h-80 overflow-y-auto pr-0.5">
            {filtered.map(item => {
              const selected = item.id === selectedId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onSelect(item);
                    handleClose();
                  }}
                  className={cn(
                    'w-full text-left px-3 py-2.5 rounded-lg border transition-colors',
                    selected
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-surface hover:border-primary hover:bg-primary/5',
                  )}
                >
                  {renderItem(item, selected)}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
