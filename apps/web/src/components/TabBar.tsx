'use client';

import { useEffect, useRef, useState, memo } from 'react';
import { X, ChevronDown, FileText } from 'lucide-react';
import { useTabBar } from '@/hooks/useTabBar';
import type { Tab } from '@/contexts/TabBarContext';
import { cn } from '@/lib/utils';

// ─── TabChip ─────────────────────────────────────────────────────────────────

interface TabChipProps {
  tab: Tab;
  onActivate: () => void;
  onClose: () => void;
}

const TabChip = memo(function TabChip({ tab, onActivate, onClose }: TabChipProps) {
  return (
    <div
      className={cn(
        'group relative flex items-center gap-1 px-2.5 h-full shrink-0 cursor-pointer select-none',
        'text-[12px] max-w-40 border-r border-border transition-colors',
        'bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 border-b-2 border-b-amber-400',
      )}
      onClick={onActivate}
      title={tab.label}
    >
      <FileText className="h-3 w-3 shrink-0 opacity-60" />
      <span className="truncate">{tab.label}</span>
      <button
        className="ml-0.5 shrink-0 rounded-sm p-0.5 opacity-0 group-hover:opacity-60 hover:opacity-100! transition-opacity"
        onClick={e => {
          e.stopPropagation();
          onClose();
        }}
        title="Закрити"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
});

// ─── Overflow dropdown ────────────────────────────────────────────────────────

interface OverflowMenuProps {
  tabs: Tab[];
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

function TabOverflowMenu({ tabs, onActivate, onClose }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0 flex items-center h-full border-r border-border">
      <button
        className="flex items-center gap-0.5 px-2 h-full text-[11px] text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors"
        onClick={() => setOpen(o => !o)}
        title="Всі відкриті"
      >
        <ChevronDown className="h-3.5 w-3.5" />
        <span>{tabs.length}</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 z-50 mt-px min-w-50 bg-surface border border-border rounded-md shadow-lg py-1">
          {tabs.map(tab => (
            <div
              key={tab.id}
              className="flex items-center gap-2 px-3 py-1.5 text-[12px] cursor-pointer hover:bg-secondary/60 text-amber-700 dark:text-amber-300"
              onClick={() => {
                onActivate(tab.id);
                setOpen(false);
              }}
            >
              <FileText className="h-3.5 w-3.5 shrink-0 opacity-60" />
              <span className="truncate flex-1">{tab.label}</span>
              <button
                className="ml-1 p-0.5 rounded hover:bg-secondary text-muted-foreground"
                onClick={e => {
                  e.stopPropagation();
                  onClose(tab.id);
                  setOpen(false);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── TabBar ───────────────────────────────────────────────────────────────────

const MAX_VISIBLE = 10;

export function TabBar() {
  const { tabs, closeTab, activateTab } = useTabBar();

  if (tabs.length === 0) return null;

  const visibleTabs = tabs.slice(0, MAX_VISIBLE);
  const hiddenTabs = tabs.slice(MAX_VISIBLE);

  return (
    <div className="hidden lg:flex items-stretch h-9 bg-surface border-b border-border shrink-0 overflow-hidden">
      {visibleTabs.map(tab => (
        <TabChip
          key={tab.id}
          tab={tab}
          onActivate={() => activateTab(tab.id)}
          onClose={() => closeTab(tab.id)}
        />
      ))}
      {hiddenTabs.length > 0 && (
        <TabOverflowMenu tabs={hiddenTabs} onActivate={activateTab} onClose={closeTab} />
      )}
    </div>
  );
}
