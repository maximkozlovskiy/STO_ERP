'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface InlineEditCellProps {
  value: string;
  saving?: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
  type?: 'text' | 'number';
  className?: string;
}

export function InlineEditCell({
  value: initialValue,
  saving = false,
  onCommit,
  onCancel,
  type = 'text',
  className,
}: InlineEditCellProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className={cn('flex items-center gap-1', className)} onClick={e => e.stopPropagation()}>
      <input
        ref={inputRef}
        type={type}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); onCommit(value); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        onBlur={() => onCommit(value)}
        disabled={saving}
        className="flex-1 min-w-0 px-1.5 py-0.5 rounded border border-primary bg-surface text-[13px] text-foreground outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
      />
      {saving ? (
        <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin shrink-0" />
      ) : (
        <>
          <button
            onMouseDown={e => { e.preventDefault(); onCommit(value); }}
            className="p-0.5 rounded text-success hover:bg-success-subtle transition-colors shrink-0"
            aria-label="Зберегти"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            onMouseDown={e => { e.preventDefault(); onCancel(); }}
            className="p-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive-subtle transition-colors shrink-0"
            aria-label="Скасувати"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
}

interface InlineViewCellProps {
  value: string;
  enabled?: boolean;
  onClick: () => void;
  className?: string;
  children?: React.ReactNode;
}

export function InlineViewCell({
  value,
  enabled = true,
  onClick,
  className,
  children,
}: InlineViewCellProps) {
  if (!enabled) return <>{children ?? <span>{value}</span>}</>;

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
      title="Натисніть для редагування"
      className={cn(
        'group cursor-text rounded px-1 -mx-1 hover:bg-primary-subtle hover:outline hover:outline-1 hover:outline-primary/30 transition-colors',
        className,
      )}
    >
      {children ?? value}
    </span>
  );
}
