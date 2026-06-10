'use client';

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PageTab {
  kind: 'page';
  id: string; // = href
  href: string;
  label: string;
}

export interface ModalTab {
  kind: 'modal';
  id: string; // uuid
  label: string;
  modalKey: string; // 'work-order' | 'invoice' | ...
  restoreProps: Record<string, unknown>;
}

export type Tab = PageTab | ModalTab;

interface TabBarContextValue {
  tabs: Tab[];
  openPageTab: (href: string, label: string) => void;
  closeTab: (id: string) => void;
  minimizeModal: (tab: Omit<ModalTab, 'id'>) => string;
  restoreModal: (id: string) => ModalTab | null;
  activePageId: string | null; // set externally by useTabBar via pathname
  setActivePageId: (id: string | null) => void;
  /** Set by TabBar when user clicks a modal tab — consumed by ModalRestorer in TopShell */
  pendingRestore: ModalTab | null;
  setPendingRestore: (tab: ModalTab | null) => void;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const TABS_KEY = 'sto_tabs';
const HIST_KEY = 'sto_tabs_hist';
const MAX_TABS = 12;

const noop = () => {};
const TabBarContext = createContext<TabBarContextValue>({
  tabs: [],
  openPageTab: noop,
  closeTab: noop,
  minimizeModal: () => '',
  restoreModal: () => null,
  activePageId: null,
  setActivePageId: noop,
  pendingRestore: null,
  setPendingRestore: noop,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadTabs(): Tab[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(TABS_KEY);
    return raw ? (JSON.parse(raw) as Tab[]) : [];
  } catch {
    return [];
  }
}

function saveTabs(tabs: Tab[]) {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
  } catch {}
}

function loadHistory(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(HIST_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(hist: string[]) {
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(hist));
  } catch {}
}

function genId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `m${Math.random().toString(36).slice(2)}`;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function TabBarProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<ModalTab | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTabs(loadTabs());
    setHistory(loadHistory());
    setMounted(true);
  }, []);

  const openPageTab = useCallback((href: string, label: string) => {
    setTabs(prev => {
      if (prev.some(t => t.kind === 'page' && t.id === href)) return prev;
      const tab: PageTab = { kind: 'page', id: href, href, label };
      const next = [...prev, tab];
      const trimmed = next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next;
      saveTabs(trimmed);
      return trimmed;
    });
    setHistory(prev => {
      const next = [...prev.filter(h => h !== href), href];
      const trimmed = next.slice(-50);
      saveHistory(trimmed);
      return trimmed;
    });
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== id);
      saveTabs(next);
      return next;
    });
    setHistory(prev => {
      const next = prev.filter(h => h !== id);
      saveHistory(next);
      return next;
    });
  }, []);

  const minimizeModal = useCallback((tab: Omit<ModalTab, 'id'>): string => {
    const id = genId();
    const fullTab: ModalTab = { ...tab, id };
    setTabs(prev => {
      const next = [...prev, fullTab];
      saveTabs(next);
      return next;
    });
    return id;
  }, []);

  const restoreModal = useCallback(
    (id: string): ModalTab | null => {
      const tab = tabs.find(t => t.id === id);
      return tab?.kind === 'modal' ? tab : null;
    },
    [tabs],
  );

  if (!mounted) return <>{children}</>;

  return (
    <TabBarContext.Provider
      value={{
        tabs,
        openPageTab,
        closeTab,
        minimizeModal,
        restoreModal,
        activePageId,
        setActivePageId,
        pendingRestore,
        setPendingRestore,
      }}
    >
      {children}
    </TabBarContext.Provider>
  );
}

// ─── Consumer hook ────────────────────────────────────────────────────────────

export function useTabBarContext() {
  return useContext(TabBarContext);
}
