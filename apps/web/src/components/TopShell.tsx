'use client';

import { useState, useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Wrench,
  CalendarDays,
  Users,
  Package,
  ShoppingCart,
  FileText,
  Receipt,
  Wallet,
  BarChart2,
  BookOpen,
  UserCog,
  Building2,
  Settings,
  CloudUpload,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Menu,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  roles?: string[];
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { href: '/dashboard',       label: 'Дашборд',     icon: LayoutDashboard },
    ],
  },
  {
    label: 'Робота',
    items: [
      { href: '/work-orders',     label: 'Наряди',      icon: Wrench },
      { href: '/calendar',        label: 'Календар',    icon: CalendarDays },
      { href: '/crm',             label: 'CRM',         icon: Users },
    ],
  },
  {
    label: 'Склад і фінанси',
    items: [
      { href: '/inventory',       label: 'Склад',       icon: Package },
      { href: '/purchase-orders', label: 'Замовлення',  icon: ShoppingCart },
      { href: '/stock-documents', label: 'Документи',   icon: FileText },
      { href: '/invoices',        label: 'Рахунки',     icon: Receipt },
      { href: '/settlements',     label: 'Розрахунки',  icon: Wallet },
      { href: '/reports',         label: 'Звіти',       icon: BarChart2, roles: ['OWNER', 'ADMIN', 'ACCOUNTANT'] },
    ],
  },
  {
    label: 'Адміністрування',
    items: [
      { href: '/catalog',         label: 'Каталог',     icon: BookOpen,    roles: ['OWNER', 'ADMIN'] },
      { href: '/employees',       label: 'Персонал',    icon: UserCog,     roles: ['OWNER', 'ADMIN'] },
      { href: '/infrastructure',  label: 'Підрозділи',  icon: Building2,   roles: ['OWNER', 'ADMIN'] },
      { href: '/settings',        label: 'Налаштування',icon: Settings,    roles: ['OWNER', 'ADMIN'] },
      { href: '/settings/sync',   label: 'Cloud Sync',  icon: CloudUpload, roles: ['OWNER', 'ADMIN'] },
    ],
  },
];

const ROLE_LABELS: Record<string, string> = {
  OWNER:        'Власник',
  ADMIN:        'Адміністратор',
  RECEPTIONIST: 'Адміністратор',
  MECHANIC:     'Механік',
  STOREKEEPER:  'Комірник',
  ACCOUNTANT:   'Бухгалтер',
  CLIENT:       'Клієнт',
};

const SIDEBAR_COLLAPSED_KEY = 'sto_sidebar_collapsed';

function isActive(pathname: string, href: string): boolean {
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname.startsWith(href);
}

const PUBLIC_ROUTES = ['/login', '/setup', '/', '/403'];

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function TopShell({ children }: { children: ReactNode }) {
  const { employee, isLoading, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      if (saved !== null) setCollapsed(saved === 'true');
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { setMobileOpen(false); }, [pathname]);

  // Render-blocking auth guard for non-public routes — prevents UI skeleton leak
  // before the per-page useRequireAuth useEffect fires its redirect.
  const isPublic = isPublicRoute(pathname);

  useEffect(() => {
    if (!isPublic && !isLoading && !employee) {
      router.replace('/login');
    }
  }, [isPublic, isLoading, employee, router]);

  if (!isPublic && (isLoading || !employee)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!employee) return <>{children}</>;

  const role = employee.role;
  const initials = `${employee.firstName?.[0] ?? ''}${employee.lastName?.[0] ?? ''}`.toUpperCase() || '?';

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const handleLogout = () => {
    if (confirm('Вийти з системи?')) { logout(); router.push('/login'); }
  };

  const SidebarNav = () => (
    <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
      {NAV_GROUPS.map((group, gi) => {
        const visible = group.items.filter(n => !n.roles || n.roles.includes(role));
        if (!visible.length) return null;
        return (
          <div key={gi} className={cn(gi > 0 && 'pt-3')}>
            {group.label && !collapsed && (
              <p className="px-2.5 mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-sidebar-muted">
                {group.label}
              </p>
            )}
            {visible.map(item => {
              const active = isActive(pathname ?? '', item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-lg text-[13px] font-medium transition-colors duration-100 mb-0.5',
                    collapsed ? 'justify-center px-0 py-2.5' : 'px-2.5 py-2',
                    active
                      ? 'bg-sidebar-active text-white'
                      : 'text-sidebar-fg hover:bg-sidebar-hover hover:text-white',
                  )}
                >
                  <Icon className="h-3.75 w-3.75 shrink-0" />
                  {!collapsed && <span className="truncate leading-none">{item.label}</span>}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className={cn(
        'flex items-center h-14 border-b border-sidebar-border shrink-0 px-3',
        collapsed ? 'justify-center' : 'justify-between',
      )}>
        {collapsed ? (
          <Link href="/dashboard" className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
            <Wrench className="h-4 w-4 text-white" />
          </Link>
        ) : (
          <Link href="/dashboard" className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary shrink-0">
              <Wrench className="h-4 w-4 text-white" />
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-[14px] font-bold text-white leading-none tracking-tight">STO ERP</span>
              <span className="text-[10px] text-sidebar-muted leading-none mt-0.5 truncate">Автосервіс</span>
            </div>
          </Link>
        )}
        <button
          onClick={toggleCollapsed}
          className={cn(
            'hidden lg:flex h-7 w-7 items-center justify-center rounded-md transition-colors',
            'text-sidebar-muted hover:text-white hover:bg-sidebar-hover',
            collapsed && 'hidden',
          )}
          title={collapsed ? 'Розгорнути' : 'Згорнути'}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>

      <SidebarNav />

      {/* User footer */}
      <div className="border-t border-sidebar-border px-2 py-2.5 shrink-0">
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-white text-[11px] font-bold">
              {initials}
            </div>
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
      {/* Desktop sidebar */}
      <aside className={cn(
        'hidden lg:flex flex-col shrink-0 bg-sidebar-bg transition-[width] duration-200 ease-in-out',
        collapsed ? 'w-13' : 'w-54',
      )}>
        <SidebarContent />
        {collapsed && (
          <button
            onClick={toggleCollapsed}
            className="absolute top-13.5 left-10 hidden lg:flex h-5 w-5 items-center justify-center rounded-full bg-primary text-white shadow-md z-10"
            title="Розгорнути"
          >
            <ChevronRight className="h-3 w-3" />
          </button>
        )}
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={() => setMobileOpen(false)} />
          <aside className="fixed inset-y-0 left-0 w-54 flex flex-col bg-sidebar-bg z-50 lg:hidden shadow-xl">
            <SidebarContent />
          </aside>
        </>
      )}

      {/* Main */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Mobile topbar */}
        <header className="flex lg:hidden items-center gap-3 px-4 h-12 bg-white border-b border-border shrink-0">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-1.5 rounded-lg hover:bg-secondary text-foreground-muted transition-colors"
            aria-label="Відкрити меню"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary">
              <Wrench className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="text-[14px] font-bold text-foreground">STO ERP</span>
          </Link>
        </header>

        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
