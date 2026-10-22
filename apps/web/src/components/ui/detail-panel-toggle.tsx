'use client';

import { PanelRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('common');
  return (
    <button
      onClick={onToggle}
      aria-label={enabled ? t('detailPanel.hide') : t('detailPanel.show')}
      title={enabled ? t('detailPanel.enabled') : t('detailPanel.disabled')}
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
