'use client';

import { ChevronDown, ChevronUp } from 'lucide-react';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

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
  /**
   * `strip` (типово) — смужка під шапкою в обох станах. `card` — стиль `DocumentSection`
   * (картка наряду, варіант A): лише згорнутий стан — картка-зведення з чипами й «Розгорнути»;
   * розгорнуту шапку згортає дія в заголовку першої секції.
   */
  variant?: 'strip' | 'card';
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
  emptyLabel,
  collapsedExtra,
  variant = 'strip',
}: CollapsibleHeaderProps) {
  // Типові підписи — з локалі, як у ConfirmDialog (Bug #911).
  const { t } = useTranslation('common');
  const visibleChips = chips.filter(c => !!c.label);

  if (variant === 'card') {
    if (!collapsed) return null;
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={false}
        className={[
          'flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-5 py-3',
          'text-left text-[13px] hover:bg-secondary/40 transition-colors select-none shrink-0',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        ].join(' ')}
      >
        <span className="flex flex-1 flex-wrap items-center gap-2 min-w-0">
          {visibleChips.length > 0 ? (
            <>
              {visibleChips.map((chip, i) => (
                <span
                  key={i}
                  className={[
                    'px-2.5 py-1 rounded-full bg-secondary truncate',
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
            <span className="text-muted-foreground">{emptyLabel ?? t('expandHeader')}</span>
          )}
        </span>
        <span className="flex items-center gap-1 font-medium text-primary shrink-0">
          {t('expand')}
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </span>
      </button>
    );
  }

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
            <span className="text-muted-foreground">{emptyLabel ?? t('expandHeader')}</span>
          )
        ) : (
          <span className="text-muted-foreground">{t('documentHeader')}</span>
        )}
      </span>
      <span className="flex items-center gap-1 text-muted-foreground shrink-0">
        {collapsed ? t('expand') : t('collapse')}
        <ChevronUp
          className="h-3 w-3 transition-transform duration-300"
          style={{ transform: collapsed ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </span>
    </button>
  );
}
