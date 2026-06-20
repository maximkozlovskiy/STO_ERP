'use client';

import {
  useId,
  useState,
  useRef,
  useEffect,
  useCallback,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Spinner } from './spinner';

export interface ComboboxItem {
  id: string;
  primary: string;
  secondary?: string;
}

interface SearchComboboxProps<T extends { id: string }> {
  label?: string;
  placeholder?: string;
  value: string;
  displayValue?: string;
  onSelect: (item: T) => void;
  onClear?: () => void;
  fetchItems: (q: string) => Promise<(T & ComboboxItem)[]>;
  disabled?: boolean;
  required?: boolean;
  errorMessage?: string;
  hint?: string;
  className?: string;
}

export function SearchCombobox<T extends { id: string }>({
  label,
  placeholder = 'Пошук...',
  value,
  displayValue,
  onSelect,
  onClear,
  fetchItems,
  disabled,
  required,
  errorMessage,
  hint,
  className,
}: SearchComboboxProps<T>) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<(T & ComboboxItem)[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Stable IDs for ARIA wiring (combobox ↔ listbox ↔ active option)
  const reactId = useId();
  const listboxId = `${reactId}-listbox`;
  const optionId = (idx: number) => `${reactId}-option-${idx}`;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Cancel any pending debounce so the fetch is not fired after unmount.
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const search = useCallback(
    (q: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!q.trim()) {
        setItems([]);
        setOpen(false);
        return;
      }
      debounceRef.current = setTimeout(async () => {
        setLoading(true);
        try {
          const results = await fetchItems(q.trim());
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
    [fetchItems],
  );

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setQuery(q);
    search(q);
  };

  const handleSelect = (item: T & ComboboxItem) => {
    onSelect(item);
    setQuery('');
    setItems([]);
    setOpen(false);
    setActiveIndex(-1);
  };

  const handleClear = () => {
    setQuery('');
    setItems([]);
    setOpen(false);
    onClear?.();
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open || items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      handleSelect(items[activeIndex]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const hasError = !!errorMessage;
  const showSelected = !!value && !!displayValue && !query;
  // коли `value` (id) встановлено, але `displayValue` ще порожній (наприклад, форма
  // відкрилася з server-state і назва підвантажується паралельним fetch'ем) — рендеримо
  // skeleton placeholder замість порожнього search input. Інакше користувач думає що вибір втрачено.
  const showLoadingPill = !!value && !displayValue && !query;

  return (
    <div className={cn('flex flex-col gap-1', className)} ref={containerRef}>
      {label && (
        <label className="text-[13px] font-medium text-foreground leading-none">
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </label>
      )}
      <div className="relative">
        {showSelected ? (
          <div
            className={cn(
              'flex items-center h-9 w-full rounded border text-[14px] text-foreground bg-surface px-3 pr-8',
              'border-border',
              hasError && 'border-destructive',
              disabled && 'opacity-60',
            )}
          >
            <span className="truncate flex-1">{displayValue}</span>
            {!disabled && (
              <button
                type="button"
                onClick={handleClear}
                className="absolute right-2 text-muted-foreground hover:text-foreground"
                aria-label="Очистити"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        ) : showLoadingPill ? (
          // placeholder поки displayValue завантажується — показує що вибір НЕ втрачено
          <div
            className={cn(
              'flex items-center h-9 w-full rounded border text-[14px] text-muted-foreground bg-surface px-3',
              'border-border',
              hasError && 'border-destructive',
              disabled && 'opacity-60',
            )}
            aria-busy="true"
            role="status"
          >
            <Spinner size="sm" />
            <span className="ml-2 truncate">Завантаження…</span>
          </div>
        ) : (
          <>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded={open && items.length > 0}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
              autoComplete="off"
              value={query}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                if (query.trim()) setOpen(true);
              }}
              placeholder={placeholder}
              disabled={disabled}
              aria-invalid={hasError}
              className={cn(
                'h-9 w-full rounded border text-[14px] text-foreground bg-surface',
                'pl-8 pr-8 py-2 outline-none transition-all duration-150',
                'border-border hover:border-border-hover',
                'focus:border-primary focus:ring-3 focus:ring-brand-100',
                'disabled:opacity-60 disabled:cursor-not-allowed',
                hasError && 'border-destructive',
              )}
            />
            {loading && (
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2">
                <Spinner size="sm" />
              </span>
            )}
          </>
        )}

        {open && items.length > 0 && (
          <ul
            ref={listRef}
            id={listboxId}
            className="absolute z-50 mt-1 w-full bg-surface border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto"
            role="listbox"
          >
            {items.map((item, idx) => (
              <li
                key={item.id}
                id={optionId(idx)}
                role="option"
                aria-selected={idx === activeIndex}
                onMouseDown={e => {
                  e.preventDefault();
                  handleSelect(item);
                }}
                className={cn(
                  'flex flex-col px-3 py-2 cursor-pointer transition-colors',
                  'hover:bg-secondary',
                  idx === activeIndex && 'bg-secondary',
                )}
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
          <div className="absolute z-50 mt-1 w-full bg-surface border border-border rounded-lg shadow-lg px-3 py-2">
            <span className="text-[13px] text-muted-foreground">Нічого не знайдено</span>
          </div>
        )}
      </div>

      {hasError && <p className="text-[12px] text-destructive leading-tight">{errorMessage}</p>}
      {!hasError && hint && (
        <p className="text-[12px] text-muted-foreground leading-tight">{hint}</p>
      )}
    </div>
  );
}
