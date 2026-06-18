'use client';

import { ChevronUp } from 'lucide-react';
import { type ReactNode } from 'react';

export interface CollapsibleHeaderChip {
  /** Text shown in the chip. Falsy value → chip is not rendered. */
  label: string | null | undefined;
  /** true = bold foreground (primary value), false = muted (secondary info) */
  primary?: boolean;
  /** Tailwind max-w-* class, e.g. "max-w-50". Default: "max-w-48" */
  maxWidth?: string;
}

interface CollapsibleHeaderProps {
  collapsed: boolean;
  onToggle: () => void;
  /** Chips shown when collapsed. Falsy labels are skipped. */
  chips: CollapsibleHeaderChip[];
  /** Fallback text when collapsed and all chips are empty */
  emptyLabel?: string;
  /** Extra content rendered to the right of chips when collapsed */
  collapsedExtra?: ReactNode;
}

/**
 * Standardized collapsible document-header toggle strip.
 *
 * Usage:
 *   <CollapsibleHeader
 *     collapsed={headerCollapsed}
 *     onToggle={() => setHeaderCollapsed(c => !c)}
 *     chips={[
 *       { label: supplierName, primary: true },
 *       { label: warehouseName },
 *     ]}
 *   />
 */
export function CollapsibleHeader({
  collapsed,
  onToggle,
  chips,
  emptyLabel = 'Розгорнути шапку',
  collapsedExtra,
}: CollapsibleHeaderProps) {
  const visibleChips = chips.filter(c => !!c.label);

  return (
    <button
      type="button"
      onClick={onToggle}
      className={[
        'flex items-center gap-2 w-full py-1.5 px-3 text-[11px]',
        'hover:bg-secondary/60 transition-colors select-none shrink-0',
        'border-t border-border',
      ].join(' ')}
    >
      <span className="flex-1 flex items-center gap-2 min-w-0 overflow-hidden">
        {collapsed ? (
          visibleChips.length > 0 ? (
            <>
              {visibleChips.map((chip, i) => (
                <span
                  key={i}
                  className={[
                    'px-2 py-0.5 rounded-full bg-secondary truncate',
                    chip.primary ? 'text-foreground font-medium' : 'text-muted-foreground',
                    chip.maxWidth ?? 'max-w-48',
                  ].join(' ')}
                >
                  {chip.label}
                </span>
              ))}
              {collapsedExtra}
            </>
          ) : (
            <span className="text-muted-foreground">{emptyLabel}</span>
          )
        ) : (
          <span className="text-muted-foreground">Шапка документа</span>
        )}
      </span>
      <span className="flex items-center gap-1 text-muted-foreground shrink-0">
        {collapsed ? 'Розгорнути' : 'Згорнути'}
        <ChevronUp
          className="h-3 w-3 transition-transform duration-300"
          style={{ transform: collapsed ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </span>
    </button>
  );
}
