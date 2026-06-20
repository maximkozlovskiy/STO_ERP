'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
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

// runtime shape validation. Старі версії TabBar зберігали tab-и з
// `kind: 'page'` або без `restoreProps`. JSON.parse + type-cast пропускав сміття
// → потім `sameIdentity(undefined, ...)` крашив, або `restoreProps.workOrderId`
// undefined відкривала модалку у create-mode замість edit. Фільтруємо при load
// і persist-имо очищений масив назад щоб не нести garbage між сесіями.
function isValidTab(t: unknown): t is Tab {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  if (o.kind !== 'modal') return false;
  if (typeof o.id !== 'string' || o.id.length === 0) return false;
  if (typeof o.label !== 'string') return false;
  if (typeof o.modalKey !== 'string' || o.modalKey.length === 0) return false;
  if (!o.restoreProps || typeof o.restoreProps !== 'object') return false;
  return true;
}

function loadTabs(): Tab[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(isValidTab);
    // Drift cleanup: запис чистий масив назад тільки якщо знайшли garbage.
    if (valid.length !== parsed.length) {
      try {
        localStorage.setItem(TABS_KEY, JSON.stringify(valid));
      } catch {
        /* ignore */
      }
    }
    return valid;
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

  // stable reference — читаємо з `tabsRef.current` (синхронізується іншим
  // useEffect-ом вище) замість залежності від `tabs`. Без цього context value
  // recreated на кожну зміну tabs → всі consumers re-render (включно з модалкою що
  // підписана лише на `minimizeModal`).
  const restoreModal = useCallback((id: string): ModalTab | null => {
    return tabsRef.current.find(t => t.id === id) ?? null;
  }, []);

  // sto-optimize: memoize context value щоб уникнути пере-рендеру ВСІХ consumers
  // коли provider re-render-иться без зміни state. Без useMemo об'єкт-літерал
  // створюється заново кожен рендер → React Context посилає ВСІМ підписникам
  // сигнал зміни → всі компоненти що читають context (Modal-и, TabBar, useTabBar
  // у різних місцях) re-render-яться навіть коли реально нічого не змінилось.
  // Зміна `tabs`/`pendingRestore` все одно тригерить новий value (правильно),
  // а minimizeModal/closeTab/restoreModal/setPendingRestore — стабільні refs
  // (useCallback з [] deps + useState setter), отже не впливають на identity.
  const value = useMemo(
    () => ({ tabs, minimizeModal, closeTab, restoreModal, pendingRestore, setPendingRestore }),
    [tabs, minimizeModal, closeTab, restoreModal, pendingRestore],
  );

  if (!mounted) return <>{children}</>;

  return <TabBarContext.Provider value={value}>{children}</TabBarContext.Provider>;
}

// ─── Consumer hook ────────────────────────────────────────────────────────────

export function useTabBarContext() {
  return useContext(TabBarContext);
}
