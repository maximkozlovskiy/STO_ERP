'use client';

import { useEffect, useRef, useState, memo } from 'react';
import { X, ChevronDown, FileText } from 'lucide-react';
import { useTabBar } from '@/hooks/useTabBar';
import type { Tab } from '@/contexts/TabBarContext';
import { cn } from '@/lib/utils';

// ─── TabChip ─────────────────────────────────────────────────────────────────

// sto-optimize: onActivate/onClose accept the tab id як аргумент — без цього
// батько передає `() => activateTab(tab.id)` inline arrow на кожен render,
// що ламає `memo` (Bug #424 fix був частковим — useCallback стабілізував
// activateTab/closeTab у hook, але inline wrappers у `.map()` все одно
// створювали нові refs кожного render → всі chip-и re-render-или при будь-якій
// зміні tabs). Тепер batter передає СТАБІЛЬНІ refs onActivate/onClose, TabChip
// викликає їх з id зі своїх props → memo прохоодить shallow-compare на tab.
interface TabChipProps {
  tab: Tab;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

const TabChip = memo(function TabChip({ tab, onActivate, onClose }: TabChipProps) {
  // Inline arrows тут безпечні — TabChip уже memo'd, кожен chip має ВЛАСНИЙ
  // identity через `tab` prop. Нові arrow refs створюються лише коли tab
  // міняється — тобто щоразу при rerender ЦІЄЇ chip-instance (через зміну tab).
  return (
    <div
      className={cn(
        'group relative flex items-center gap-1 px-2.5 h-full shrink-0 cursor-pointer select-none',
        'text-[12px] max-w-40 border-r border-border transition-colors',
        'bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 border-b-2 border-b-amber-400',
      )}
      onClick={() => onActivate(tab.id)}
      title={tab.label}
    >
      <FileText className="h-3 w-3 shrink-0 opacity-60" />
      <span className="truncate">{tab.label}</span>
      <button
        className="ml-0.5 shrink-0 rounded-sm p-0.5 opacity-0 group-hover:opacity-60 focus-visible:opacity-100 hover:opacity-100! transition-opacity"
        onClick={e => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        title="Закрити"
        aria-label="Закрити вкладку"
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
        // sto-optimize: передаємо СТАБІЛЬНІ refs (activateTab/closeTab з useCallback)
        // — без inline-arrow обгорток. TabChip memo тепер реально працює: коли
        // змінюється ОДНА tab у списку, інші chip-и не re-render-яться.
        <TabChip key={tab.id} tab={tab} onActivate={activateTab} onClose={closeTab} />
      ))}
      {hiddenTabs.length > 0 && (
        <TabOverflowMenu tabs={hiddenTabs} onActivate={activateTab} onClose={closeTab} />
      )}
    </div>
  );
}
