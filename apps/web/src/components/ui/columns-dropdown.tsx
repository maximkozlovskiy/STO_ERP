'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Columns3, GripVertical, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ColumnDef } from '@/hooks/useTableColumns';

interface ColumnsDropdownProps {
  columns: ColumnDef[];
  visibleKeys: Set<string>;
  onToggle: (key: string) => void;
  /** Storage key for persisting custom labels + order */
  pageKey?: string;
  className?: string;
}

const LS_ORDER = (k: string) => `sto_col_order_${k}`;
const LS_LABELS = (k: string) => `sto_col_labels_${k}`;

function loadOrder(pageKey: string, keys: string[]): string[] {
  try {
    const raw = localStorage.getItem(LS_ORDER(pageKey));
    if (!raw) return keys;
    const stored: unknown = JSON.parse(raw);
    if (Array.isArray(stored) && stored.every(x => typeof x === 'string')) {
      // merge: keep stored order for known keys, append new keys at end
      const set = new Set(keys);
      const ordered = (stored as string[]).filter(k => set.has(k));
      keys.filter(k => !ordered.includes(k)).forEach(k => ordered.push(k));
      return ordered;
    }
  } catch { /* ignore */ }
  return keys;
}

function loadLabels(pageKey: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(LS_LABELS(pageKey));
    if (!raw) return {};
    const stored: unknown = JSON.parse(raw);
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      return stored as Record<string, string>;
    }
  } catch { /* ignore */ }
  return {};
}

export function ColumnsDropdown({ columns, visibleKeys, onToggle, pageKey, className }: ColumnsDropdownProps) {
  const [open, setOpen] = useState(false);
  const [configMode, setConfigMode] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Order state
  const defaultOrder = columns.map(c => c.key);
  const [order, setOrder] = useState<string[]>(defaultOrder);

  // Custom labels
  const [customLabels, setCustomLabels] = useState<Record<string, string>>({});
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [labelValue, setLabelValue] = useState('');

  // Hydrate from localStorage
  useEffect(() => {
    if (!pageKey) return;
    setOrder(loadOrder(pageKey, defaultOrder));
    setCustomLabels(loadLabels(pageKey));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey]);

  // Sorted columns
  const sortedCols = [...columns].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  const getLabel = (col: ColumnDef) => customLabels[col.key] ?? col.label;

  // Click outside closes
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfigMode(false);
        setEditingLabel(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Drag-and-drop reorder
  const dragKeyRef = useRef<string | null>(null);

  const handleDragStart = (key: string) => { dragKeyRef.current = key; };
  const handleDrop = useCallback((targetKey: string) => {
    const dragKey = dragKeyRef.current;
    if (!dragKey || dragKey === targetKey) return;
    const newOrder = [...order];
    const from = newOrder.indexOf(dragKey);
    const to = newOrder.indexOf(targetKey);
    newOrder.splice(from, 1);
    newOrder.splice(to, 0, dragKey);
    setOrder(newOrder);
    if (pageKey) {
      try { localStorage.setItem(LS_ORDER(pageKey), JSON.stringify(newOrder)); } catch { /* ignore */ }
    }
    dragKeyRef.current = null;
  }, [order, pageKey]);

  // Save custom label
  const saveLabel = (key: string) => {
    const trimmed = labelValue.trim();
    const next = { ...customLabels };
    if (trimmed && trimmed !== columns.find(c => c.key === key)?.label) {
      next[key] = trimmed;
    } else {
      delete next[key];
    }
    setCustomLabels(next);
    if (pageKey) {
      try { localStorage.setItem(LS_LABELS(pageKey), JSON.stringify(next)); } catch { /* ignore */ }
    }
    setEditingLabel(null);
  };

  // Reset all customization
  const reset = () => {
    setOrder(defaultOrder);
    setCustomLabels({});
    if (pageKey) {
      try { localStorage.removeItem(LS_ORDER(pageKey)); localStorage.removeItem(LS_LABELS(pageKey)); } catch { /* ignore */ }
    }
  };

  const hasCustomization = pageKey && (
    JSON.stringify(order) !== JSON.stringify(defaultOrder) ||
    Object.keys(customLabels).length > 0
  );

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        onClick={() => { setOpen(v => !v); setConfigMode(false); setEditingLabel(null); }}
        aria-label="Налаштувати колонки"
        className={cn(
          'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-surface text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors',
          open && 'bg-secondary text-foreground',
        )}
      >
        <Columns3 className="h-4 w-4 shrink-0" aria-hidden="true" />
        Колонки
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-50 w-60 bg-surface border border-border rounded-xl shadow-lg overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-[12px] font-medium text-muted-foreground">
              {configMode ? 'Налаштування колонок' : 'Видимість колонок'}
            </span>
            <div className="flex items-center gap-1">
              {hasCustomization && (
                <button
                  onClick={reset}
                  title="Скинути"
                  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
              {pageKey && (
                <button
                  onClick={() => { setConfigMode(v => !v); setEditingLabel(null); }}
                  className={cn(
                    'text-[11px] px-2 py-0.5 rounded border transition-colors',
                    configMode
                      ? 'border-primary text-primary bg-primary/5'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {configMode ? 'Готово' : 'Змінити'}
                </button>
              )}
            </div>
          </div>

          {/* Column list */}
          <div className="py-1 max-h-72 overflow-y-auto">
            {sortedCols.map(col => (
              <div
                key={col.key}
                draggable={configMode}
                onDragStart={() => handleDragStart(col.key)}
                onDragOver={e => { e.preventDefault(); }}
                onDrop={() => handleDrop(col.key)}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 hover:bg-secondary select-none',
                  configMode && 'cursor-grab active:cursor-grabbing',
                )}
              >
                {/* Drag handle */}
                {configMode && (
                  <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                )}

                {/* Checkbox */}
                <input
                  type="checkbox"
                  checked={visibleKeys.has(col.key)}
                  onChange={() => onToggle(col.key)}
                  onClick={e => e.stopPropagation()}
                  className="h-3.5 w-3.5 rounded border-border shrink-0"
                />

                {/* Label — editable in config mode */}
                {configMode && editingLabel === col.key ? (
                  <input
                    autoFocus
                    value={labelValue}
                    onChange={e => setLabelValue(e.target.value)}
                    onBlur={() => saveLabel(col.key)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveLabel(col.key);
                      if (e.key === 'Escape') setEditingLabel(null);
                    }}
                    className="flex-1 text-[13px] bg-surface border border-primary rounded px-1.5 py-0.5 text-foreground outline-none min-w-0"
                  />
                ) : (
                  <span
                    className={cn(
                      'flex-1 text-[13px] text-foreground truncate',
                      configMode && 'hover:text-primary cursor-text',
                      customLabels[col.key] && 'font-medium',
                    )}
                    onClick={() => {
                      if (!configMode) return;
                      setEditingLabel(col.key);
                      setLabelValue(getLabel(col));
                    }}
                    title={configMode ? 'Клік для зміни назви' : undefined}
                  >
                    {getLabel(col)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
