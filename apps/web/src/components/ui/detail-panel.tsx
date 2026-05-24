'use client';

import { type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DetailPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export function DetailPanel({ open, onClose, title, children }: DetailPanelProps) {
  return (
    <div
      className={cn(
        'flex flex-col shrink-0 border-l border-border bg-surface transition-[width] duration-200 overflow-hidden',
        open ? 'w-80' : 'w-0',
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <h2 className="text-[14px] font-semibold text-foreground truncate">{title}</h2>
        <button
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
          title="Закрити"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-4">
        {children}
      </div>
    </div>
  );
}
