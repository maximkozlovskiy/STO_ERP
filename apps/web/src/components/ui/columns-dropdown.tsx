'use client';

import { useState, useRef, useEffect } from 'react';
import { Columns3, GripVertical, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ColumnDef } from '@/hooks/useTableColumns';

interface ColumnsDropdownProps {
  columns: ColumnDef[]; // orderedColumns from useTableColumns (already sorted + labelled)
  visibleKeys: Set<string>;
  onToggle: (key: string) => void;
  onReorder?: (newOrder: string[]) => void;
  onRename?: (key: string, label: string | null) => void;
  onReset?: () => void;
  hasCustomization?: boolean;
  className?: string;
}

export function ColumnsDropdown({
  columns,
  visibleKeys,
  onToggle,
  onReorder,
  onRename,
  onReset,
  hasCustomization,
  className,
}: ColumnsDropdownProps) {
  const [open, setOpen] = useState(false);
  const [configMode, setConfigMode] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [labelValue, setLabelValue] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const dragKeyRef = useRef<string | null>(null);

  const configurable = !!(onReorder || onRename);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfigMode(false);
        setEditingKey(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleDragStart = (key: string) => {
    dragKeyRef.current = key;
  };

  const handleDrop = (targetKey: string) => {
    const dragKey = dragKeyRef.current;
    if (!dragKey || dragKey === targetKey || !onReorder) return;
    const keys = columns.map(c => c.key);
    const from = keys.indexOf(dragKey);
    const to = keys.indexOf(targetKey);
    keys.splice(from, 1);
    keys.splice(to, 0, dragKey);
    onReorder(keys);
    dragKeyRef.current = null;
  };

  const saveLabel = (key: string) => {
    const trimmed = labelValue.trim();
    // Find original label from columns def (before any customization)
    // null = reset to default
    onRename?.(key, trimmed || null);
    setEditingKey(null);
  };

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        onClick={() => {
          setOpen(v => !v);
          setConfigMode(false);
          setEditingKey(null);
        }}
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
              {hasCustomization && onReset && (
                <button
                  onClick={onReset}
                  title="Скинути налаштування"
                  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
              {configurable && (
                <button
                  onClick={() => {
                    setConfigMode(v => !v);
                    setEditingKey(null);
                  }}
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
            {columns.map(col => (
              <div
                key={col.key}
                draggable={configMode && !!onReorder}
                onDragStart={() => handleDragStart(col.key)}
                onDragOver={e => e.preventDefault()}
                onDrop={() => handleDrop(col.key)}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 hover:bg-secondary select-none',
                  configMode && onReorder && 'cursor-grab active:cursor-grabbing',
                )}
              >
                {configMode && onReorder && (
                  <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                )}

                <input
                  type="checkbox"
                  checked={visibleKeys.has(col.key)}
                  onChange={() => onToggle(col.key)}
                  onClick={e => e.stopPropagation()}
                  className="h-3.5 w-3.5 rounded border-border shrink-0"
                />

                {configMode && onRename && editingKey === col.key ? (
                  <input
                    autoFocus
                    value={labelValue}
                    onChange={e => setLabelValue(e.target.value)}
                    onBlur={() => saveLabel(col.key)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveLabel(col.key);
                      if (e.key === 'Escape') setEditingKey(null);
                    }}
                    className="flex-1 text-[13px] bg-surface border border-primary rounded px-1.5 py-0.5 text-foreground outline-none min-w-0"
                  />
                ) : (
                  <span
                    className={cn(
                      'flex-1 text-[13px] text-foreground truncate',
                      configMode && onRename && 'hover:text-primary cursor-text',
                    )}
                    onClick={() => {
                      if (!configMode || !onRename) return;
                      setEditingKey(col.key);
                      setLabelValue(col.label);
                    }}
                    title={configMode && onRename ? 'Клік для зміни назви' : undefined}
                  >
                    {col.label}
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
