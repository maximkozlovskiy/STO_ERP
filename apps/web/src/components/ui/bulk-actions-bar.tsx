'use client';

import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

export interface BulkAction {
  id: string;
  label: string;
  variant?: 'default' | 'destructive' | 'outline';
  icon?: ReactNode;
  disabled?: boolean;
  onClick: (selectedIds: string[]) => void;
}

interface BulkActionsBarProps {
  count: number;
  selectedIds: string[];
  actions: BulkAction[];
  onClear: () => void;
  className?: string;
}

export function BulkActionsBar({ count, selectedIds, actions, onClear, className }: BulkActionsBarProps) {
  if (count === 0) return null;

  return (
    <div className={cn(
      'flex items-center gap-3 px-4 py-2.5 bg-primary-subtle border border-primary/20 rounded-xl',
      className,
    )}>
      <span className="text-[13px] font-medium text-primary shrink-0">
        Обрано: {count}
      </span>
      <div className="flex items-center gap-2 flex-wrap flex-1">
        {actions.map(action => (
          <Button
            key={action.id}
            size="sm"
            variant={action.variant ?? 'outline'}
            onClick={() => action.onClick(selectedIds)}
            disabled={action.disabled}
          >
            {action.icon}
            {action.label}
          </Button>
        ))}
      </div>
      <button
        onClick={onClear}
        className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        aria-label="Скасувати вибір"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
