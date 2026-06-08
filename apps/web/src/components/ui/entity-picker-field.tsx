'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { MoreHorizontal, Search, X } from 'lucide-react';
import { Spinner } from './spinner';

interface SearchItem {
  id: string;
  primary: string;
  secondary?: string;
}

interface EntityPickerFieldProps<T extends SearchItem = SearchItem> {
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
  /**
   * Optional fulltext search. When provided, the display area becomes a text
   * input that fires onSearch(q) on each keystroke (debounced 300ms).
   * Results are shown in a dropdown; selecting calls onSearchSelect(item).
   * The "..." and 🔍 buttons remain in place.
   */
  onSearch?: (q: string) => Promise<T[]>;
  onSearchSelect?: (item: T) => void;
}

/**
 * Standard inline-button field for entity references.
 * Layout: [ display text / search input    × 🔍 … ]
 *   ×  — clear selection (shown only when value selected and not disabled)
 *   🔍 — open detail modal/page; disabled when onOpenDetail is undefined
 *   …  — open SearchPickerModal; hidden when hidePick=true
 *
 * When onSearch is provided the display span becomes a text input with a
 * live-search dropdown. The caller decides what "open detail" means (modal,
 * drawer, new tab, etc.) by providing onOpenDetail.
 */
export function EntityPickerField<T extends SearchItem = SearchItem>({
  display,
  placeholder = 'Обрати…',
  disabled = false,
  hidePick = false,
  onOpenDetail,
  onPick,
  onClear,
  onSearch,
  onSearchSelect,
}: EntityPickerFieldProps<T>) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!onSearch) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onSearch]);

  // Reset query when selection changes externally (e.g. cleared via onClear)
  useEffect(() => {
    if (!display) setQuery('');
  }, [display]);

  const runSearch = useCallback(
    (q: string) => {
      if (!onSearch) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!q.trim()) {
        setItems([]);
        setOpen(false);
        return;
      }
      debounceRef.current = setTimeout(async () => {
        setLoading(true);
        try {
          const results = await onSearch(q.trim());
          if (mountedRef.current) {
            setItems(results);
            setOpen(true);
            setActiveIndex(-1);
          }
        } catch {
          if (mountedRef.current) setItems([]);
        } finally {
          if (mountedRef.current) setLoading(false);
        }
      }, 300);
    },
    [onSearch],
  );

  const handleSelect = (item: T) => {
    onSearchSelect?.(item);
    setQuery('');
    setItems([]);
    setOpen(false);
    setActiveIndex(-1);
  };

  const handleClear = () => {
    setQuery('');
    setItems([]);
    setOpen(false);
    onClear();
    inputRef.current?.focus();
  };

  // When onSearch is provided and no item is selected — show input; otherwise
  // show the selected display value (same as before, just as a non-editable span
  // with an "×" to clear and start a new search).
  const searchMode = !!onSearch;
  // True when an item is selected (display is non-empty)
  const hasValue = !!display;

  return (
    <div
      ref={containerRef}
      className="relative flex items-center gap-1 rounded-lg border border-border bg-surface px-3 h-9 min-w-0"
    >
      {/* Main content area */}
      {searchMode && !hasValue ? (
        // Search input — visible only when nothing selected yet
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            runSearch(e.target.value);
          }}
          onKeyDown={e => {
            if (!open || items.length === 0) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActiveIndex(i => Math.min(i + 1, items.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActiveIndex(i => Math.max(i - 1, 0));
            } else if (e.key === 'Enter' && activeIndex >= 0) {
              e.preventDefault();
              handleSelect(items[activeIndex]!);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          onFocus={() => {
            if (query.trim() && items.length > 0) setOpen(true);
          }}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          className="flex-1 min-w-0 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
        />
      ) : (
        // Display span — same as original
        <span
          className={`flex-1 text-sm truncate ${hasValue ? 'text-foreground' : 'text-muted-foreground'}`}
        >
          {hasValue ? display : placeholder}
        </span>
      )}

      {/* Spinner when searching */}
      {searchMode && loading && !hasValue && (
        <span className="shrink-0">
          <Spinner size="sm" />
        </span>
      )}

      {/* Clear */}
      {hasValue && !disabled && (
        <button
          type="button"
          onClick={handleClear}
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

      {/* Dropdown */}
      {open && items.length > 0 && (
        <ul className="absolute z-50 top-full left-0 right-0 mt-1 bg-surface border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto">
          {items.map((item, idx) => (
            <li
              key={item.id}
              onMouseDown={e => {
                e.preventDefault();
                handleSelect(item);
              }}
              className={`flex flex-col px-3 py-2 cursor-pointer transition-colors hover:bg-secondary ${idx === activeIndex ? 'bg-secondary' : ''}`}
            >
              <span className="text-[14px] text-foreground leading-snug">{item.primary}</span>
              {item.secondary && (
                <span className="text-[12px] text-muted-foreground leading-tight">
                  {item.secondary}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {open && !loading && items.length === 0 && query.trim() && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-surface border border-border rounded-lg shadow-lg px-3 py-2">
          <span className="text-[13px] text-muted-foreground">Нічого не знайдено</span>
        </div>
      )}
    </div>
  );
}
