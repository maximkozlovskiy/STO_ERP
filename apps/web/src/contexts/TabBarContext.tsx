'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';

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

// Identifying keys that uniquely tie a modal tab to an entity. Two tabs with the same
// modalKey AND the same value on ALL identity keys are considered the same tab.
const IDENTITY_KEYS = ['workOrderId', 'invoiceId', 'id'] as const;

function sameIdentity(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const key of IDENTITY_KEYS) {
    const av = a[key];
    const bv = b[key];
    if (av !== undefined || bv !== undefined) {
      // Once we see any identity key in either side — compare it; if they differ, not same.
      if (av !== bv) return false;
    }
  }
  // If no identity key is present in either side — fall back to NOT same (do not dedupe
  // anonymous restore-prop sets — they may legitimately differ).
  const hasAny = IDENTITY_KEYS.some(k => a[k] !== undefined || b[k] !== undefined);
  return hasAny;
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

  // Ref-mirror of `tabs` so minimizeModal can dedupe without taking `tabs` as a callback
  // dep (which would re-create the callback on every tab change and force consumers to
  // re-memoize). We read from the ref to find an existing entry, then commit via setTabs.
  const tabsRef = useRef<Tab[]>([]);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const minimizeModal = useCallback((tab: Omit<ModalTab, 'id'>): string => {
    // Dedupe by (modalKey + identifying restoreProps) — restoring a tab and minimizing
    // again must NOT create a duplicate entry for the same underlying entity.
    const existing = tabsRef.current.find(
      t =>
        t.kind === 'modal' &&
        t.modalKey === tab.modalKey &&
        sameIdentity(t.restoreProps, tab.restoreProps),
    );
    if (existing) {
      setTabs(prev => {
        const next = prev.map(t =>
          // Re-check in updater in case state moved between read and write (StrictMode-safe).
          t.id === existing.id ? { ...t, label: tab.label, restoreProps: tab.restoreProps } : t,
        );
        saveTabs(next);
        return next;
      });
      return existing.id;
    }
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
