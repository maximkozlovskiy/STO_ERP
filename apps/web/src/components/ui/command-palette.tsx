'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Search, ArrowRight, Navigation, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getCommands, searchCommands, type Command } from '@/lib/commands';

const GROUP_LABELS: Record<string, string> = {
  navigation: 'Навігація',
  action:     'Дії',
  settings:   'Налаштування',
};
const GROUP_ICONS: Record<string, typeof Navigation> = {
  navigation: Navigation,
  action:     Zap,
  settings:   Zap,
};

interface CommandPaletteProps {
  open: boolean;
  role: string;
  onClose: () => void;
}

export function CommandPalette({ open, role, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const allCommands = getCommands(role);
  const filtered = searchCommands(allCommands, query);

  // Group filtered results
  const groups = filtered.reduce<Record<string, Command[]>>((acc, cmd) => {
    (acc[cmd.group] ??= []).push(cmd);
    return acc;
  }, {});

  // Flat list for keyboard navigation
  const flatList = Object.values(groups).flat();

  const runCommand = useCallback((cmd: Command) => {
    cmd.perform({ router, role });
    onClose();
  }, [router, role, onClose]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => { setActiveIndex(0); }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, flatList.length - 1)); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (flatList[activeIndex]) runCommand(flatList[activeIndex]);
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, flatList, activeIndex, onClose, runCommand]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[300] flex items-start justify-center pt-[10vh] px-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      {/* Panel */}
      <div className="relative w-full max-w-lg bg-surface rounded-2xl border border-border shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Пошук команд і сторінок..."
            className="flex-1 bg-transparent text-[14px] text-foreground placeholder:text-muted-foreground outline-none"
          />
          <kbd className="shrink-0 text-[11px] text-muted-foreground bg-secondary border border-border rounded px-1.5 py-0.5">Esc</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[360px] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-muted-foreground">Нічого не знайдено</p>
          ) : (
            Object.entries(groups).map(([group, cmds]) => {
              const GroupIcon = GROUP_ICONS[group] ?? Navigation;
              return (
                <div key={group}>
                  <p className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    {GROUP_LABELS[group] ?? group}
                  </p>
                  {cmds.map((cmd) => {
                    const idx = flatList.indexOf(cmd);
                    const isActive = idx === activeIndex;
                    return (
                      <button
                        key={cmd.id}
                        data-index={idx}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => runCommand(cmd)}
                        className={cn(
                          'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
                          isActive ? 'bg-primary text-white' : 'text-foreground hover:bg-secondary',
                        )}
                      >
                        <GroupIcon className={cn('h-4 w-4 shrink-0', isActive ? 'text-white' : 'text-muted-foreground')} />
                        <span className="flex-1 text-[13px] font-medium">{cmd.label}</span>
                        {cmd.description && (
                          <span className={cn('text-[12px]', isActive ? 'text-white/70' : 'text-muted-foreground')}>{cmd.description}</span>
                        )}
                        <ArrowRight className={cn('h-3.5 w-3.5 shrink-0', isActive ? 'text-white/70' : 'text-muted-foreground/40')} />
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
          <span><kbd className="bg-secondary border border-border rounded px-1 py-0.5">↑↓</kbd> навігація</span>
          <span><kbd className="bg-secondary border border-border rounded px-1 py-0.5">Enter</kbd> відкрити</span>
          <span><kbd className="bg-secondary border border-border rounded px-1 py-0.5">Esc</kbd> закрити</span>
        </div>
      </div>
    </div>
  );
}
