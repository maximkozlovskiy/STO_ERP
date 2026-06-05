'use client';

import { MoreHorizontal, Search, X } from 'lucide-react';

interface EntityPickerFieldProps {
  /** Displayed name of the selected entity */
  display: string;
  placeholder?: string;
  disabled?: boolean;
  /** Hide the "..." pick button (e.g. in read-only mode) */
  hidePick?: boolean;
  /**
   * Called when the 🔍 button is clicked.
   * Undefined = button is disabled (no entity selected yet).
   */
  onOpenDetail?: () => void;
  onPick: () => void;
  onClear: () => void;
}

/**
 * Standard inline-button field for entity references.
 * Layout: [ display text    × 🔍 … ]
 *   ×  — clear selection (shown only when value selected and not disabled)
 *   🔍 — open detail modal/page; disabled when onOpenDetail is undefined
 *   …  — open SearchPickerModal; hidden when hidePick=true
 *
 * The caller decides what "open detail" means (modal, drawer, new tab, etc.)
 * by providing onOpenDetail. This keeps the component decoupled from routing.
 */
export function EntityPickerField({
  display,
  placeholder = 'Обрати…',
  disabled = false,
  hidePick = false,
  onOpenDetail,
  onPick,
  onClear,
}: EntityPickerFieldProps) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-surface px-3 h-9 min-w-0">
      <span
        className={`flex-1 text-sm truncate ${display ? 'text-foreground' : 'text-muted-foreground'}`}
      >
        {display || placeholder}
      </span>

      {/* Clear */}
      {display && !disabled && (
        <button
          type="button"
          onClick={onClear}
          className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
          aria-label="Очистити"
          title="Очистити"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Open detail */}
      <button
        type="button"
        disabled={!onOpenDetail}
        onClick={onOpenDetail}
        className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label="Відкрити картку"
        title={onOpenDetail ? 'Відкрити картку' : 'Спочатку оберіть запис'}
      >
        <Search className="h-3.5 w-3.5" />
      </button>

      {/* Open picker */}
      {!hidePick && (
        <button
          type="button"
          onClick={onPick}
          className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0"
          aria-label="Обрати"
          title="Обрати зі списку"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
