'use client';

import { PanelRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DetailPanelToggleProps {
  enabled: boolean;
  onToggle: () => void;
  className?: string;
}

/**
 * Icon button placed next to ColumnsDropdown.
 * Active (enabled) = clicking a row opens the detail panel.
 * Inactive = rows are not clickable for detail.
 */
export function DetailPanelToggle({ enabled, onToggle, className }: DetailPanelToggleProps) {
  return (
    <button
      onClick={onToggle}
      aria-label={enabled ? 'Сховати бокову панель' : 'Показати бокову панель'}
      title={enabled ? 'Бокова панель увімкнена' : 'Бокова панель вимкнена'}
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[13px] transition-colors',
        enabled
          ? 'bg-primary text-primary-foreground border-primary hover:bg-primary/90'
          : 'border-border bg-surface text-muted-foreground hover:bg-secondary hover:text-foreground',
        className,
      )}
    >
      <PanelRight className="h-4 w-4 shrink-0" />
    </button>
  );
}
