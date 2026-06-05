'use client';

import { useEffect, useMemo, useRef, useState, useCallback, useId } from 'react';
import { useRouter } from 'next/navigation';
import { Search, ArrowRight, Navigation, Zap, Database } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getCommands, searchCommands, type Command } from '@/lib/commands';
import { apiFetch } from '@/lib/api-client';

const GROUP_LABELS: Record<string, string> = {
  navigation: 'Навігація',
  action: 'Дії',
  settings: 'Налаштування',
  data: 'Дані',
};
const GROUP_ICONS: Record<string, typeof Navigation> = {
  navigation: Navigation,
  action: Zap,
  settings: Zap,
  data: Database,
};

interface SearchResultItem {
  type: string;
  id: string;
  label: string;
  sub?: string;
  extra?: Record<string, unknown>;
}

interface CommandPaletteProps {
  open: boolean;
  role: string;
  onClose: () => void;
}

// For types where a detail page exists we append the entity id; otherwise we fall back to the
// list view. Without this distinction the palette swallowed the click context — selecting
// «ТОВ Альфа» from the palette dropped the user on the /crm list and forced a second search.
const DATA_ROUTE: Record<string, { list: string; detail?: (id: string) => string }> = {
  wo: { list: '/work-orders', detail: id => `/work-orders/${id}` },
  counterparty: { list: '/counterparties', detail: id => `/counterparties/${id}` },
  good: { list: '/catalog' /* no /catalog/[id] route yet */ },
};

export function CommandPalette({ open, role, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [dataResults, setDataResults] = useState<SearchResultItem[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Stable IDs from React 18+ — replaces non-deterministic Math.random()
  const reactId = useId();
  const titleId = `cmd-palette-title-${reactId}`;
  const listboxId = `cmd-palette-listbox-${reactId}`;
  const optionId = (idx: number) => `cmd-palette-option-${reactId}-${idx}`;

  // Remember the focused element BEFORE the palette opened so we can restore it on close (a11y).
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Memoize commands per role to avoid re-creating array each render
  const allCommands = useMemo(() => getCommands(role), [role]);
  const filtered = useMemo(() => searchCommands(allCommands, query), [allCommands, query]);

  // Group filtered results
  const groups = useMemo(
    () =>
      filtered.reduce<Record<string, Command[]>>((acc, cmd) => {
        (acc[cmd.group] ??= []).push(cmd);
        return acc;
      }, {}),
    [filtered],
  );

  // Convert data search results to Command-like objects
  const dataCommands = useMemo<Command[]>(
    () =>
      dataResults.map(item => ({
        id: `data-${item.type}-${item.id}`,
        label: item.label,
        description: item.sub ?? (item.extra?.status as string | undefined),
        group: 'data',
        perform: ({ router: r }) => {
          const route = DATA_ROUTE[item.type];
          r.push(route?.detail ? route.detail(item.id) : (route?.list ?? '/'));
        },
      })),
    [dataResults],
  );

  // Flat list for keyboard navigation
  const allGroups = useMemo(() => {
    const base = { ...groups };
    if (dataCommands.length > 0) base.data = dataCommands;
    return base;
  }, [groups, dataCommands]);

  const flatList = useMemo(() => Object.values(allGroups).flat(), [allGroups]);

  // O(1) lookup of command → flat index (replaces O(n) indexOf in render).
  const flatIndex = useMemo(() => {
    const map = new Map<Command, number>();
    flatList.forEach((cmd, i) => map.set(cmd, i));
    return map;
  }, [flatList]);

  const runCommand = useCallback(
    (cmd: Command) => {
      cmd.perform({ router, role });
      onClose();
    },
    [router, role, onClose],
  );

  useEffect(() => {
    if (open) {
      // Save current focus so we can restore it when palette closes (WAI-ARIA dialog pattern).
      previousFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
      setQuery('');
      setActiveIndex(0);
      const id = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(id);
    }
    // Closing → restore focus to the trigger element (e.g. the "Пошук..." button in sidebar).
    const prev = previousFocusRef.current;
    if (prev && typeof prev.focus === 'function') {
      // Defer one tick so the dialog unmount completes before focus moves.
      const id = window.setTimeout(() => prev.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Debounced data search via /search API
  useEffect(() => {
    if (query.length < 2) {
      setDataResults([]);
      return;
    }
    setDataLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await apiFetch<{ items: SearchResultItem[] }>(
          `/search?q=${encodeURIComponent(query)}&limit=6`,
        );
        setDataResults(res.items ?? []);
      } catch {
        setDataResults([]);
      } finally {
        setDataLoading(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  // Keep refs to flatList/activeIndex so the keydown listener is registered
  // once per `open` toggle (not on every render that creates a new flatList).
  const flatListRef = useRef(flatList);
  const activeIndexRef = useRef(activeIndex);
  useEffect(() => {
    flatListRef.current = flatList;
  }, [flatList]);
  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex(i => Math.min(i + 1, flatListRef.current.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = flatListRef.current[activeIndexRef.current];
        if (cmd) runCommand(cmd);
        return;
      }
      // Focus trap: keep Tab inside the modal (only one focusable: the input)
      if (e.key === 'Tab') {
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }
    };
    // capture=true so we win against global shortcut listeners (Alt+W/D/C/I, N, ?)
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [open, onClose, runCommand]);

  if (!open) return null;

  const activeOptionId = flatList[activeIndex] ? optionId(activeIndex) : undefined;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-300 flex items-start justify-center pt-[10vh] px-4"
    >
      <h2 id={titleId} className="sr-only">
        Командна палітра
      </h2>

      {/* Backdrop — clicking it closes the palette. Must be on the backdrop itself
          (not the outer flex container) because backdrop visually covers the whole
          surface, so clicks outside the panel land here, not on the parent. */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        aria-hidden="true"
        onMouseDown={e => {
          // Only the backdrop itself should close — not bubbled clicks from the panel.
          if (e.target === e.currentTarget) onClose();
        }}
      />

      {/* Panel */}
      <div className="relative w-full max-w-lg bg-surface rounded-2xl border border-border shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Пошук команд і сторінок..."
            aria-label="Пошук команд"
            role="combobox"
            aria-expanded={flatList.length > 0}
            aria-controls={listboxId}
            aria-activedescendant={activeOptionId}
            aria-autocomplete="list"
            className="flex-1 bg-transparent text-[14px] text-foreground placeholder:text-muted-foreground outline-none"
          />
          <kbd className="shrink-0 text-[11px] text-muted-foreground bg-secondary border border-border rounded px-1.5 py-0.5">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Результати пошуку"
          className="max-h-90 overflow-y-auto py-1"
        >
          {dataLoading && query.length >= 2 && (
            <p className="px-4 py-2 text-[12px] text-muted-foreground animate-pulse">
              Пошук у даних…
            </p>
          )}
          {flatList.length === 0 && !dataLoading ? (
            <p className="py-8 text-center text-[13px] text-muted-foreground">Нічого не знайдено</p>
          ) : (
            Object.entries(allGroups).map(([group, cmds]) => {
              const GroupIcon = GROUP_ICONS[group] ?? Navigation;
              return (
                <div key={group}>
                  <p className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    {GROUP_LABELS[group] ?? group}
                  </p>
                  {cmds.map(cmd => {
                    // O(1) lookup via Map — was O(n) with flatList.indexOf
                    const idx = flatIndex.get(cmd) ?? -1;
                    const isActive = idx === activeIndex;
                    return (
                      <button
                        key={cmd.id}
                        id={optionId(idx)}
                        role="option"
                        aria-selected={isActive}
                        data-index={idx}
                        // Use mousemove (not mouseenter) so the keyboard-driven activeIndex
                        // is NOT overridden when filtered list shifts under a stationary cursor.
                        onMouseMove={() => {
                          if (activeIndex !== idx) setActiveIndex(idx);
                        }}
                        onClick={() => runCommand(cmd)}
                        className={cn(
                          'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
                          isActive ? 'bg-primary text-white' : 'text-foreground hover:bg-secondary',
                        )}
                      >
                        <GroupIcon
                          className={cn(
                            'h-4 w-4 shrink-0',
                            isActive ? 'text-white' : 'text-muted-foreground',
                          )}
                          aria-hidden="true"
                        />
                        <span className="flex-1 text-[13px] font-medium">{cmd.label}</span>
                        {cmd.description && (
                          <span
                            className={cn(
                              'text-[12px]',
                              isActive ? 'text-white/70' : 'text-muted-foreground',
                            )}
                          >
                            {cmd.description}
                          </span>
                        )}
                        <ArrowRight
                          className={cn(
                            'h-3.5 w-3.5 shrink-0',
                            isActive ? 'text-white/70' : 'text-muted-foreground/40',
                          )}
                          aria-hidden="true"
                        />
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {/* Footer hint */}
        <div className="border-t border-border px-4 py-2 flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>
            <kbd className="bg-secondary border border-border rounded px-1 py-0.5">↑↓</kbd>{' '}
            навігація
          </span>
          <span>
            <kbd className="bg-secondary border border-border rounded px-1 py-0.5">Enter</kbd>{' '}
            відкрити
          </span>
          <span>
            <kbd className="bg-secondary border border-border rounded px-1 py-0.5">Esc</kbd> закрити
          </span>
        </div>
      </div>
    </div>
  );
}
