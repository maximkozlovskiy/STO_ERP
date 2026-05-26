'use client';

import { useState, useRef, useEffect } from 'react';
import { Columns3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ColumnDef } from '@/hooks/useTableColumns';

interface ColumnsDropdownProps {
  columns: ColumnDef[];
  visibleKeys: Set<string>;
  onToggle: (key: string) => void;
  className?: string;
}

export function ColumnsDropdown({ columns, visibleKeys, onToggle, className }: ColumnsDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        onClick={() => setOpen(v => !v)}
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
        <div className="absolute right-0 top-full mt-1.5 z-50 w-48 bg-surface border border-border rounded-xl shadow-lg py-1 overflow-hidden">
          {columns.map(col => (
            <label
              key={col.key}
              className="flex items-center gap-2.5 px-3 py-2 hover:bg-secondary cursor-pointer select-none"
            >
              <input
                type="checkbox"
                checked={visibleKeys.has(col.key)}
                onChange={() => onToggle(col.key)}
                className="h-3.5 w-3.5 rounded border-border"
              />
              <span className="text-[13px] text-foreground">{col.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
