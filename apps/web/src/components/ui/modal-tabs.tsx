'use client';

import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface ModalTab {
  key: string;
  label: string;
  icon?: ReactNode;
  /** Badge count shown next to label */
  count?: number;
  content: ReactNode;
}

interface ModalTabsProps {
  tabs: ModalTab[];
  defaultTab?: string;
  className?: string;
}

/**
 * Bottom section of a modal form for 1→N related objects.
 * Used in reference-data modals (CRM, Employees, Catalog…)
 * when the entity has child collections (vehicles, assignments, lines…).
 *
 * Usage:
 * ```tsx
 * <Modal size="lg" ...>
 *   <div className="space-y-4">
 *     {/* main fields *\/}
 *   </div>
 *   {editingItem && (
 *     <ModalTabs
 *       tabs={[
 *         { key: 'vehicles', label: 'Авто', count: vehicles.length, content: <VehiclesTab /> },
 *       ]}
 *     />
 *   )}
 * </Modal>
 * ```
 */
export function ModalTabs({ tabs, defaultTab, className }: ModalTabsProps) {
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.key ?? '');

  if (tabs.length === 0) return null;

  const activeTab = tabs.find(t => t.key === active) ?? tabs[0]!;

  return (
    <div className={cn('mt-5 border-t border-border', className)}>
      {/* Tab strip */}
      <div className="flex gap-0 border-b border-border overflow-x-auto">
        {tabs.map(tab => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActive(tab.key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0',
              active === tab.key
                ? 'text-primary border-primary'
                : 'text-muted-foreground border-transparent hover:text-foreground',
            )}
          >
            {tab.icon}
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={cn(
                  'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-semibold',
                  active === tab.key
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-muted-foreground',
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="pt-4">{activeTab.content}</div>
    </div>
  );
}
