'use client';

import { useRef, useState, type ReactNode } from 'react';
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

/** Bottom edge (viewport px) of the nearest scrollable ancestor; the window when there is none. */
function scrollBottom(el: HTMLElement): number {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node.getBoundingClientRect().bottom;
  }
  return window.innerHeight;
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
  // On a tab switch the content area keeps the part of its height that is visible right now.
  // Otherwise, in a scrolled modal body, a shorter tab makes the browser clamp scrollTop and the
  // tab strip jumps down under the cursor. Only the visible part is kept: a very long tab must
  // not leave a screen-high blank area behind it.
  const contentRef = useRef<HTMLDivElement>(null);
  const [minHeight, setMinHeight] = useState(0);

  const selectTab = (key: string) => {
    const el = contentRef.current;
    if (el && key !== active) {
      const rect = el.getBoundingClientRect();
      setMinHeight(Math.round(Math.min(rect.height, Math.max(0, scrollBottom(el) - rect.top))));
    }
    setActive(key);
  };

  if (tabs.length === 0) return null;

  const activeTab = tabs.find(t => t.key === active) ?? tabs[0];

  return (
    <div className={cn('mt-5 border-t border-border', className)}>
      {/* Tab strip */}
      <div className="flex gap-0 border-b border-border overflow-x-auto">
        {tabs.map(tab => (
          <button
            key={tab.key}
            type="button"
            onClick={() => selectTab(tab.key)}
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
                  'inline-flex items-center justify-center min-w-4.5 h-4.5 px-1 rounded-full text-[11px] font-semibold',
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
      <div ref={contentRef} className="pt-4" style={minHeight ? { minHeight } : undefined}>
        {activeTab.content}
      </div>
    </div>
  );
}
