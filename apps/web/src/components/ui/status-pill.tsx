'use client';

import { memo } from 'react';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';

interface StatusPillProps {
  value: string;
  label: string;
  active: boolean;
  description?: string;
  onSelect: (v: string) => void;
}

const StatusPill = memo(function StatusPill({
  value,
  label,
  active,
  description,
  onSelect,
}: StatusPillProps) {
  const btn = (
    <button
      onClick={() => onSelect(value)}
      className={cn(
        'px-3 py-1 rounded-full text-sm font-medium border transition-colors',
        active
          ? 'bg-primary text-primary-foreground border-primary shadow-sm'
          : 'border-border text-muted-foreground bg-surface hover:bg-secondary hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
  return description ? <Tooltip content={description}>{btn}</Tooltip> : btn;
});

export { StatusPill };
