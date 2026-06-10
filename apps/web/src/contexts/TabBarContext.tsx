'use client';

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ModalTab {
  kind: 'modal';
  id: string;
  label: string;
  modalKey: string; // 'work-order' | 'invoice' | ...
  restoreProps: Record<string, unknown>;
}

export type Tab = ModalTab;

interface TabBarContextValue {
  tabs: Tab[];
  minimizeModal: (tab: Omit<ModalTab, 'id'>) => string;
  closeTab: (id: string) => void;
  restoreModal: (id: string) => ModalTab | null;
  /** Set by TabBar when user clicks a modal tab — consumed by ModalRestorer in TopShell */
  pendingRestore: ModalTab | null;
  setPendingRestore: (tab: ModalTab | null) => void;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const TABS_KEY = 'sto_modal_tabs';

const noop = () => {};
const TabBarContext = createContext<TabBarContextValue>({
  tabs: [],
  minimizeModal: () => '',
  closeTab: noop,
  restoreModal: () => null,
  pendingRestore: null,
  setPendingRestore: noop,
});

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

function genId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `m${Math.random().toString(36).slice(2)}`;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function TabBarProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [pendingRestore, setPendingRestore] = useState<ModalTab | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTabs(loadTabs());
    setMounted(true);
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

  const closeTab = useCallback((id: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== id);
      saveTabs(next);
      return next;
    });
  }, []);

  const restoreModal = useCallback(
    (id: string): ModalTab | null => {
      return tabs.find(t => t.id === id) ?? null;
    },
    [tabs],
  );

  if (!mounted) return <>{children}</>;

  return (
    <TabBarContext.Provider
      value={{ tabs, minimizeModal, closeTab, restoreModal, pendingRestore, setPendingRestore }}
    >
      {children}
    </TabBarContext.Provider>
  );
}

// ─── Consumer hook ────────────────────────────────────────────────────────────

export function useTabBarContext() {
  return useContext(TabBarContext);
}
