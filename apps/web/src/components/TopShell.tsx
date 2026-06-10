'use client';

import { useState, useEffect, useCallback, type ReactNode, type MouseEvent } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { usePathname, useRouter } from 'next/navigation';
import { TabBar } from '@/components/TabBar';
import { useTabBarContext } from '@/contexts/TabBarContext';

const CreateWorkOrderModal = dynamic(
  () => import('@/components/ui/CreateWorkOrderModal').then(m => m.CreateWorkOrderModal),
  { ssr: false },
);
import { Wrench, LogOut, ChevronLeft, Menu, Star, Search, type LucideIcon } from 'lucide-react';
import { NAV_GROUPS, NAV_GROUPS_FUNCTIONS, type NavItem, type NavGroup } from '@/lib/nav';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth, isPublicRoute } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api-client';
import { kyivToday } from '@/lib/format';
import { workOrdersKeys } from '@/hooks/api/useWorkOrders';
import { counterpartiesKeys } from '@/hooks/api/useCounterparties';
import { invoicesKeys } from '@/hooks/api/useInvoices';
import { purchaseOrdersKeys } from '@/hooks/api/usePurchaseOrders';
import { employeesKeys } from '@/hooks/api/useEmployees';
import { bookingKeys } from '@/hooks/api/useBookingRequests';
import { pricingRulesKeys } from '@/hooks/api/usePricingRules';
import { stockDocsKeys } from '@/hooks/api/useStockDocuments';
import { infraKeys } from '@/hooks/api/useInfrastructure';
import { dashboardKeys } from '@/hooks/api/useDashboardData';
import { syncKeys } from '@/hooks/api/useSyncStatus';
import { worksKeys } from '@/hooks/api/useWorks';
import { reportsKeys } from '@/hooks/api/useReports';
import { ToastContainer } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useKeyboardShortcut } from '@/hooks/useKeyboardShortcut';
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts';

// Lazy-loaded shell widgets — рендеряться умовно через uiFeatures flags + потребують
// auth (employee) для будь-якого корисного контенту. Виносимо у окремий chunk щоб
// initial layout.js не тягнув ~700+ рядків JSX/логіки які видно лише після логіну.
// ssr:false бо ці компоненти обходять SSR-render (мають client-only stores і timers).
const CommandPalette = dynamic(
  () => import('@/components/ui/command-palette').then(m => m.CommandPalette),
  { ssr: false },
);
const SyncIndicator = dynamic(
  () => import('@/components/ui/sync-indicator').then(m => m.SyncIndicator),
  { ssr: false },
);
const NotificationCenter = dynamic(
  () => import('@/components/ui/notification-center').then(m => m.NotificationCenter),
  { ssr: false },
);

// NavItem, NavGroup, NAV_GROUPS, NAV_GROUPS_FUNCTIONS — імпортовані з @/lib/nav.
// Щоб додати/перенести пункт меню — редагуй ТІЛЬКИ apps/web/src/lib/nav.ts.

const NAV_MODE_KEY = 'sto_nav_mode';
type NavMode = 'sections' | 'functions';

// Flat list of all nav items for bookmark lookup (deduplicated by href)
const ALL_NAV_ITEMS: NavItem[] = (() => {
  const seen = new Set<string>();
  return [...NAV_GROUPS, ...NAV_GROUPS_FUNCTIONS]
    .flatMap(g => g.items)
    .filter(item => {
      if (seen.has(item.href)) return false;
      seen.add(item.href);
      return true;
    });
})();

// Module-level Kyiv date formatter — лише для weekStart (today → централізований kyivToday).
const KYIV_DATE_FMT = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });

// Prefetch API даних при hover на NavLink — дані готові до кліку (~200мс).
// prefetchQuery — no-op якщо дані вже fresh (staleTime не минув), безпечно.
type PrefetchFn = (qc: ReturnType<typeof useQueryClient>) => void;
const PREFETCH_MAP: Record<string, PrefetchFn> = {
  // Bug #281: prefetch queryKey МАЄ збігатися з тим що page-споживач передає у useXxx({...}).
  // Якщо ключі різні — react-query тримає prefetched data у окремому cache slot який сторінка
  // ніколи не читає. Default filter shape копіюємо з конкретної сторінки first-mount state.
  '/work-orders': qc => {
    // Bug #356: shape МАЄ збігатися з work-orders/page.tsx first-mount useWorkOrders({...}).
    // Поля dateFrom/dateTo/sortBy/sortDir додані пізніше — без них prefetch у dead cache slot.
    const today = kyivToday();
    void qc.prefetchQuery({
      queryKey: workOrdersKeys.list({
        page: 1,
        limit: 20,
        status: '',
        repairCategory: undefined,
        q: '',
        showDeleted: false,
        employeeId: undefined,
        dateFrom: today,
        dateTo: today,
        sortBy: 'createdAt',
        sortDir: 'desc',
      }),
      queryFn: ({ signal }) =>
        apiFetch(
          `/work-orders?page=1&limit=20&dateFrom=${today}&dateTo=${today}&sortBy=createdAt&sortDir=desc`,
          { signal },
        ),
      staleTime: 30_000,
    });
  },
  '/counterparties': qc =>
    void qc.prefetchQuery({
      // Bug #356: shape match counterparties/page.tsx first-mount useCounterparties({...})
      // — useSortState('lastName','asc') додає sortBy/sortDir.
      queryKey: counterpartiesKeys.list({
        page: 1,
        limit: 20,
        types: '',
        q: '',
        showDeleted: false,
        sortBy: 'lastName',
        sortDir: 'asc',
      }),
      queryFn: ({ signal }) =>
        apiFetch('/counterparties?page=1&limit=20&sortBy=lastName&sortDir=asc', { signal }),
      staleTime: 30_000,
    }),
  '/invoices': qc => {
    // Bug #356: shape МАЄ збігатися з invoices/page.tsx first-mount useInvoices({...})
    // — dateFrom/dateTo defaults до kyivToday(), useSortState('createdAt','desc').
    const today = kyivToday();
    void qc.prefetchQuery({
      queryKey: invoicesKeys.list({
        page: 1,
        limit: 20,
        status: '',
        q: '',
        showDeleted: false,
        dateFrom: today,
        dateTo: today,
        sortBy: 'createdAt',
        sortDir: 'desc',
      }),
      queryFn: ({ signal }) =>
        apiFetch(
          `/invoices?page=1&limit=20&dateFrom=${today}&dateTo=${today}&sortBy=createdAt&sortDir=desc`,
          { signal },
        ),
      staleTime: 30_000,
    });
  },
  '/inventory': qc =>
    void qc.prefetchQuery({
      queryKey: ['inventory', 'items', {}],
      queryFn: ({ signal }) => apiFetch('/stock-items?limit=50', { signal }),
      staleTime: 30_000,
    }),
  '/purchase-orders': qc => {
    // Bug #356: shape МАЄ збігатися з purchase-orders/page.tsx first-mount.
    const today = kyivToday();
    void qc.prefetchQuery({
      queryKey: purchaseOrdersKeys.list({
        page: 1,
        limit: 20,
        status: '',
        q: '',
        showDeleted: false,
        dateFrom: today,
        dateTo: today,
        sortBy: 'createdAt',
        sortDir: 'desc',
      }),
      queryFn: ({ signal }) =>
        apiFetch(
          `/purchase-orders?page=1&limit=20&dateFrom=${today}&dateTo=${today}&sortBy=createdAt&sortDir=desc`,
          { signal },
        ),
      staleTime: 30_000,
    });
  },
  '/employees': qc =>
    void qc.prefetchQuery({
      // Bug #356: shape match employees/page.tsx first-mount useEmployees({...}).
      // Page шле undefined для q/role (через `|| undefined`), не порожні рядки.
      queryKey: employeesKeys.list({
        q: undefined,
        role: undefined,
        showDeleted: false,
        sortBy: 'lastName',
        sortDir: 'asc',
        page: 1,
        limit: 20,
      }),
      queryFn: ({ signal }) =>
        apiFetch('/employees?sortBy=lastName&sortDir=asc&page=1&limit=20', { signal }),
      staleTime: 30_000,
    }),
  '/settlements': qc =>
    void qc.prefetchQuery({
      // settlements/page.tsx:74 — useCounterparties({ limit: 200, q: debouncedQ || undefined }) default
      queryKey: counterpartiesKeys.list({ limit: 200, q: undefined }),
      queryFn: ({ signal }) => apiFetch('/counterparties?limit=200', { signal }),
      staleTime: 30_000,
    }),
  '/bookings': qc =>
    void qc.prefetchQuery({
      queryKey: bookingKeys.list(),
      queryFn: ({ signal }) =>
        apiFetch<{ items: unknown[]; total: number }>('/booking', { signal }).then(
          r => r.items ?? [],
        ),
      staleTime: 30_000,
    }),
  '/pricing-rules': qc =>
    void qc.prefetchQuery({
      queryKey: pricingRulesKeys.list(),
      queryFn: ({ signal }) =>
        apiFetch<{ items: unknown[]; total: number }>('/pricing-rules', { signal }).then(
          d => d.items,
        ),
      staleTime: 30_000,
    }),
  '/stock-documents': qc => {
    // Bug #356: shape МАЄ збігатися з stock-documents/page.tsx first-mount useStockDocuments({...}).
    const today = kyivToday();
    void qc.prefetchQuery({
      queryKey: stockDocsKeys.list({
        page: 1,
        limit: 20,
        type: undefined,
        status: undefined,
        showDeleted: false,
        dateFrom: today,
        dateTo: today,
        sortBy: 'createdAt',
        sortDir: 'desc',
      }),
      queryFn: ({ signal }) =>
        apiFetch(
          `/stock-documents?page=1&limit=20&dateFrom=${today}&dateTo=${today}&sortBy=createdAt&sortDir=desc`,
          { signal },
        ),
      staleTime: 30_000,
    });
  },
  '/infrastructure': qc => {
    void qc.prefetchQuery({
      queryKey: infraKeys.branches,
      queryFn: ({ signal }) => apiFetch('/branches', { signal }),
      staleTime: 5 * 60_000,
    });
    void qc.prefetchQuery({
      queryKey: infraKeys.zones,
      queryFn: ({ signal }) => apiFetch('/zones', { signal }),
      staleTime: 5 * 60_000,
    });
    void qc.prefetchQuery({
      queryKey: infraKeys.lifts,
      queryFn: ({ signal }) => apiFetch('/lifts', { signal }),
      staleTime: 5 * 60_000,
    });
    void qc.prefetchQuery({
      queryKey: infraKeys.warehouses,
      queryFn: ({ signal }) => apiFetch('/warehouses', { signal }),
      staleTime: 5 * 60_000,
    });
  },
  '/dashboard': qc => {
    const today = kyivToday();
    // weekStart = 7 днів тому (як у useDashboardRevenue — Date.now() - 6 days).
    const weekStart = KYIV_DATE_FMT.format(new Date(Date.now() - 6 * 86_400_000));
    void qc.prefetchQuery({
      queryKey: dashboardKeys.orders(),
      queryFn: ({ signal }) => apiFetch('/work-orders?limit=200', { signal }),
      staleTime: 60_000,
    });
    void qc.prefetchQuery({
      queryKey: dashboardKeys.lowStock(),
      queryFn: ({ signal }) => apiFetch('/stock-items/low', { signal }),
      staleTime: 60_000,
    });
    void qc.prefetchQuery({
      queryKey: dashboardKeys.invoices(),
      queryFn: ({ signal }) => apiFetch('/invoices?status=SENT&limit=200', { signal }),
      staleTime: 60_000,
    });
    void qc.prefetchQuery({
      queryKey: dashboardKeys.revenue(weekStart, today),
      queryFn: ({ signal }) =>
        apiFetch(`/reports/revenue?from=${weekStart}&to=${today}`, { signal }),
      staleTime: 60_000,
    });
    void qc.prefetchQuery({
      queryKey: dashboardKeys.maintenance(),
      queryFn: ({ signal }) => apiFetch('/maintenance-schedules/upcoming?days=30', { signal }),
      staleTime: 60_000,
    });
  },
  '/settings/sync': qc =>
    void qc.prefetchQuery({
      queryKey: syncKeys.status(),
      queryFn: ({ signal }) => apiFetch('/sync/status', { signal }),
      staleTime: 30_000,
    }),
  '/catalog': qc =>
    void qc.prefetchQuery({
      // catalog/WorksTab.tsx:106 — useWorks({ page: 1, limit: 30, categoryId: undefined, q: undefined })
      queryKey: worksKeys.list({
        page: 1,
        limit: 30,
        categoryId: undefined,
        q: undefined,
      }),
      queryFn: ({ signal }) => apiFetch('/works?page=1&limit=30', { signal }),
      staleTime: 30_000,
    }),
  // Reports: дефолтні дати на сторінці — from = початок року (Kyiv), to = today (Kyiv).
  // Prefetch revenue tab (initial tab за замовчуванням) щоб графік відразу видно.
  '/reports': qc => {
    const today = kyivToday();
    const yearStart = `${today.slice(0, 4)}-01-01`;
    void qc.prefetchQuery({
      queryKey: reportsKeys.report('revenue', yearStart, today),
      queryFn: ({ signal }) =>
        apiFetch(`/reports/revenue?from=${yearStart}&to=${today}`, { signal }),
      staleTime: 5 * 60_000,
    });
  },
  // Calendar: підйомники — стабільні reference data, prefetch при hover.
  // Слоти прив'язані до конкретної дати — prefetch today.
  '/calendar': qc => {
    const today = kyivToday();
    void qc.prefetchQuery({
      queryKey: infraKeys.lifts,
      queryFn: ({ signal }) => apiFetch('/lifts', { signal }),
      staleTime: 5 * 60_000,
    });
    void qc.prefetchQuery({
      queryKey: ['calendar', 'slots', today],
      queryFn: ({ signal }) => apiFetch(`/calendar/slots?date=${today}`, { signal }),
      staleTime: 30_000,
    });
  },
};

const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Власник',
  ADMIN: 'Адміністратор',
  RECEPTIONIST: 'Приймальник',
  MECHANIC: 'Механік',
  STOREKEEPER: 'Комірник',
  ACCOUNTANT: 'Бухгалтер',
  CLIENT: 'Клієнт',
  XLSX_MANAGER: 'Менеджер імпорту',
};

const SIDEBAR_COLLAPSED_KEY = 'sto_sidebar_collapsed';
const BOOKMARKS_KEY = 'sto_bookmarks';

function isActive(pathname: string, href: string): boolean {
  if (href === '/dashboard') return pathname === '/dashboard';
  // Exact match for routes that are prefixes of other routes
  if (href === '/settings') return pathname === '/settings' || pathname === '/settings/';
  return pathname.startsWith(href);
}

// Bug #282: PUBLIC_ROUTES + isPublicRoute імпортуються з @/lib/auth (SSOT). Раніше дублювались
// тут, що ризикувало drift при додаванні нового public route (`/forgot-password` тощо).

export function TopShell({ children }: { children: ReactNode }) {
  const { employee, isLoading, logout } = useAuth();
  const { confirm, dialogProps } = useConfirm();
  const pathname = usePathname();
  const router = useRouter();

  const [mounted, setMounted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [navMode, setNavMode] = useState<NavMode>('sections');
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Bookmarks: start empty to avoid SSR mismatch; hydrated via useEffect
  const [bookmarks, setBookmarks] = useState<string[]>([]);

  const uiFeatures = useUiFeatures();
  const queryClient = useQueryClient();

  // Modal restore from TabBar modal tabs
  const { pendingRestore, setPendingRestore, closeTab } = useTabBarContext();
  const [restoredWoId, setRestoredWoId] = useState<string | undefined>(undefined);
  // Track the tab UUID (not the WO ID) so closeTab removes the correct tab entry
  const [restoredTabId, setRestoredTabId] = useState<string | undefined>(undefined);
  const [restoredWoOpen, setRestoredWoOpen] = useState(false);

  useEffect(() => {
    if (!pendingRestore) return;
    if (pendingRestore.modalKey === 'work-order') {
      const raw = pendingRestore.restoreProps.workOrderId;
      const woId = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
      setRestoredWoId(woId);
      setRestoredTabId(pendingRestore.id);
      setRestoredWoOpen(true);
      setPendingRestore(null);
    }
  }, [pendingRestore, setPendingRestore]);

  useKeyboardShortcut(
    'ctrl+k',
    useCallback(
      e => {
        e.preventDefault();
        if (uiFeatures.commandPaletteEnabled && employee) setPaletteOpen(p => !p);
      },
      [uiFeatures.commandPaletteEnabled, employee],
    ),
    { enabled: true, allowInInput: true },
  );

  // Disable global shortcuts while palette is open so Alt+W/D/C/I/N don't navigate behind it
  useGlobalShortcuts(!!employee && uiFeatures.keyboardShortcutsEnabled && !paletteOpen);

  useEffect(() => {
    setMounted(true);
    try {
      const saved = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      if (saved !== null) setCollapsed(saved === 'true');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(BOOKMARKS_KEY);
      if (saved) setBookmarks(JSON.parse(saved) as string[]);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(NAV_MODE_KEY) as NavMode | null;
      if (saved === 'sections' || saved === 'functions') setNavMode(saved);
    } catch {
      /* ignore */
    }
    const handler = (e: Event) => {
      const mode = (e as CustomEvent<NavMode>).detail;
      setNavMode(mode);
      try {
        localStorage.setItem(NAV_MODE_KEY, mode);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('sto:nav-mode-change', handler);
    return () => window.removeEventListener('sto:nav-mode-change', handler);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const toggleBookmark = useCallback((href: string, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setBookmarks(prev => {
      const next = prev.includes(href) ? prev.filter(b => b !== href) : [...prev, href];
      try {
        localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // Render-blocking auth guard for non-public routes — prevents UI skeleton leak
  // before the per-page useRequireAuth useEffect fires its redirect.
  const isPublic = isPublicRoute(pathname);

  useEffect(() => {
    if (!isPublic && !isLoading && !employee) {
      router.replace('/login');
    }
  }, [isPublic, isLoading, employee, router]);

  // Public routes (login, setup, /) always render without shell,
  // even if employee is present (e.g. cached session on /login → redirect handled by login page itself)
  if (isPublic) return <>{children}</>;

  // Before mount: return null so SSR and first client render match (no hydration mismatch)
  if (!mounted) return null;

  if (isLoading || !employee) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const role = employee.role;
  const initials =
    `${employee.firstName?.[0] ?? ''}${employee.lastName?.[0] ?? ''}`.toUpperCase() || '?';

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const handleLogout = async () => {
    if (await confirm({ title: 'Вийти з системи?' })) {
      logout();
      router.push('/login');
    }
  };

  const NavLink = ({ item, showStar = true }: { item: NavItem; showStar?: boolean }) => {
    const active = isActive(pathname ?? '', item.href);
    const Icon = item.icon;
    const isBookmarked = bookmarks.includes(item.href);

    return (
      <Link
        key={item.href}
        href={item.href}
        prefetch={true}
        onMouseEnter={() => employee && PREFETCH_MAP[item.href]?.(queryClient)}
        title={collapsed ? item.label : undefined}
        className={cn(
          'group relative flex items-center gap-3 rounded-lg text-[13px] font-medium transition-colors duration-100 mb-0.5',
          collapsed ? 'justify-center px-0 py-2.5 mx-1.5' : 'px-2.5 py-2',
          active
            ? 'bg-sidebar-active text-white'
            : 'text-sidebar-fg hover:bg-sidebar-hover hover:text-white',
        )}
      >
        <Icon className="h-5 w-5 shrink-0" />
        {!collapsed && <span className="truncate leading-none flex-1">{item.label}</span>}
        {!collapsed && showStar && (
          <button
            onClick={e => toggleBookmark(item.href, e)}
            className={cn(
              'h-5 w-5 flex items-center justify-center rounded transition-opacity shrink-0',
              isBookmarked
                ? 'opacity-100 text-amber-400'
                : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-sidebar-muted hover:text-amber-400',
            )}
            title={isBookmarked ? 'Видалити закладку' : 'Додати закладку'}
          >
            <Star className={cn('h-3.5 w-3.5', isBookmarked && 'fill-current')} />
          </button>
        )}
      </Link>
    );
  };

  const SidebarNav = () => {
    const bookmarkedItems = ALL_NAV_ITEMS.filter(
      item => bookmarks.includes(item.href) && (!item.roles || item.roles.includes(role)),
    );
    const activeGroups = navMode === 'sections' ? NAV_GROUPS : NAV_GROUPS_FUNCTIONS;

    return (
      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
        {/* Bookmarks section — only when bookmarks exist */}
        {bookmarkedItems.length > 0 && (
          <div className="pb-1">
            {!collapsed && (
              <p className="px-2.5 mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-sidebar-muted">
                Закладки
              </p>
            )}
            {bookmarkedItems.map(item => (
              <NavLink key={`bookmark-${item.href}`} item={item} showStar={false} />
            ))}
          </div>
        )}

        {/* Regular nav groups */}
        {activeGroups.map((group, gi) => {
          const visible = group.items.filter(n => !n.roles || n.roles.includes(role));
          if (!visible.length) return null;
          return (
            <div key={gi} className={cn((gi > 0 || bookmarkedItems.length > 0) && 'pt-3')}>
              {group.label && !collapsed && (
                <p className="px-2.5 mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-sidebar-muted">
                  {group.label}
                </p>
              )}
              {visible.map(item => (
                <NavLink key={item.href} item={item} />
              ))}
            </div>
          );
        })}
      </nav>
    );
  };

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div
        className={cn(
          'flex items-center h-14 border-b border-sidebar-border shrink-0',
          collapsed ? 'justify-center px-0' : 'justify-between px-3',
        )}
      >
        {collapsed ? (
          <button
            onClick={toggleCollapsed}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary hover:bg-primary-hover transition-colors"
            title="Розгорнути"
          >
            <Wrench className="h-5 w-5 text-white" />
          </button>
        ) : (
          <>
            <Link href="/dashboard" prefetch={false} className="flex items-center gap-2.5 min-w-0">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary shrink-0">
                <Wrench className="h-4 w-4 text-white" />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-[14px] font-bold text-white leading-none tracking-tight">
                  STO ERP
                </span>
                <span className="text-[10px] text-sidebar-muted leading-none mt-0.5 truncate">
                  Автосервіс
                </span>
              </div>
            </Link>
            <button
              onClick={toggleCollapsed}
              className="hidden lg:flex h-7 w-7 items-center justify-center rounded-md transition-colors text-sidebar-muted hover:text-white hover:bg-sidebar-hover"
              title="Згорнути"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

      {/* Command Palette trigger — desktop sidebar */}
      {!collapsed && uiFeatures.commandPaletteEnabled && (
        <div className="px-2 pb-1">
          <button
            onClick={() => setPaletteOpen(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-sidebar-hover/40 text-sidebar-muted hover:bg-sidebar-hover hover:text-white transition-colors text-[12px]"
          >
            <Search className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 text-left">Пошук...</span>
            <kbd className="text-[10px] bg-sidebar-hover border border-sidebar-border rounded px-1">
              Ctrl K
            </kbd>
          </button>
        </div>
      )}

      <SidebarNav />

      {/* User footer */}
      <div className="border-t border-sidebar-border px-2 py-2.5 shrink-0">
        {!collapsed && uiFeatures.syncIndicatorEnabled && (
          <div className="px-2 pb-2">
            <SyncIndicator />
          </div>
        )}
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-white text-[11px] font-bold">
              {initials}
            </div>
            {uiFeatures.notificationCenterEnabled && (
              <NotificationCenter enabled={uiFeatures.notificationCenterEnabled} />
            )}
            <button
              onClick={handleLogout}
              className="flex h-7 w-7 items-center justify-center rounded-md text-sidebar-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
              title="Вийти"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-white text-[11px] font-bold shrink-0">
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-white leading-tight truncate">
                {employee.firstName} {employee.lastName}
              </div>
              <div className="text-[11px] text-sidebar-muted leading-tight truncate">
                {ROLE_LABELS[role] ?? role}
              </div>
            </div>
            {uiFeatures.notificationCenterEnabled && (
              <NotificationCenter enabled={uiFeatures.notificationCenterEnabled} />
            )}
            <button
              onClick={handleLogout}
              className="flex h-7 w-7 items-center justify-center rounded-md text-sidebar-muted hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
              title="Вийти"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <ToastContainer />
      <ConfirmDialog {...dialogProps} />
      {employee && uiFeatures.commandPaletteEnabled && (
        <CommandPalette open={paletteOpen} role={role} onClose={() => setPaletteOpen(false)} />
      )}
      {restoredWoOpen && restoredWoId && (
        <CreateWorkOrderModal
          open={restoredWoOpen}
          workOrderId={restoredWoId}
          onClose={() => {
            setRestoredWoOpen(false);
            setRestoredWoId(undefined);
            setRestoredTabId(undefined);
          }}
          onUpdated={() => {
            // Remove the modal tab using the tab UUID (not the WO ID) so closeTab finds the right entry
            if (restoredTabId) closeTab(restoredTabId);
          }}
        />
      )}
      {/* Desktop sidebar */}
      <aside
        className={cn(
          'hidden lg:flex flex-col shrink-0 bg-sidebar-bg transition-[width] duration-200 ease-in-out',
          collapsed ? 'w-15' : 'w-54',
        )}
      >
        <SidebarContent />
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-40 lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="fixed inset-y-0 left-0 w-54 flex flex-col bg-sidebar-bg z-50 lg:hidden shadow-xl">
            <SidebarContent />
          </aside>
        </>
      )}

      {/* Main */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Mobile topbar */}
        <header className="flex lg:hidden items-center gap-3 px-4 h-12 bg-surface border-b border-border shrink-0">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-1.5 rounded-lg hover:bg-secondary text-foreground-muted transition-colors"
            aria-label="Відкрити меню"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Link href="/dashboard" prefetch={false} className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary">
              <Wrench className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="text-[14px] font-bold text-foreground">STO ERP</span>
          </Link>
          {uiFeatures.commandPaletteEnabled && (
            <button
              onClick={() => setPaletteOpen(true)}
              className="ml-auto flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-secondary text-muted-foreground text-[12px] hover:bg-secondary/80 transition-colors"
              aria-label="Відкрити пошук"
            >
              <Search className="h-3.5 w-3.5" />
              <span>Пошук</span>
            </button>
          )}
        </header>

        <TabBar />
        <main className="flex-1 min-h-0 flex flex-col overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
