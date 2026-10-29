'use client';

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
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

export function BulkActionsBar({
  count,
  selectedIds,
  actions,
  onClear,
  className,
}: BulkActionsBarProps) {
  const { t } = useTranslation('common');
  if (count === 0) return null;

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-2.5 bg-primary-subtle border border-primary/20 rounded-xl',
        className,
      )}
    >
      <span className="text-[13px] font-medium text-primary shrink-0">
        {t('bulkActions.selected', { n: count })}
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
        aria-label={t('bulkActions.clearSelection')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

interface ListBulkActionsProps {
  /** Стан списку (`useListPage()`): чи увімкнені масові дії в налаштуваннях інтерфейсу. */
  list: { features: { bulkActionsEnabled: boolean } };
  /** Стан вибору списку (`useBulkSelect`). */
  bulk: { count: number; selected: ReadonlySet<string>; clear: () => void };
  actions: BulkAction[];
}

/** Панель масових дій списку над таблицею: лише коли дії увімкнені й щось вибрано. */
export function ListBulkActions({ list, bulk, actions }: ListBulkActionsProps) {
  if (!list.features.bulkActionsEnabled) return null;
  return (
    <BulkActionsBar
      count={bulk.count}
      selectedIds={Array.from(bulk.selected)}
      actions={actions}
      onClear={bulk.clear}
    />
  );
}
