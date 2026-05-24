'use client';

import { useState, useEffect } from 'react';
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
  X,
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

const NAV: NavItem[] = [
  { href: '/dashboard',        label: 'Дашборд',     icon: LayoutDashboard },
  { href: '/work-orders',      label: 'Наряди',       icon: Wrench },
  { href: '/calendar',         label: 'Календар',     icon: CalendarDays },
  { href: '/crm',              label: 'CRM',          icon: Users },
  { href: '/inventory',        label: 'Склад',        icon: Package },
  { href: '/purchase-orders',  label: 'Замовлення',   icon: ShoppingCart },
  { href: '/stock-documents',  label: 'Документи',    icon: FileText },
  { href: '/invoices',         label: 'Рахунки',      icon: Receipt },
  { href: '/settlements',      label: 'Розрахунки',   icon: Wallet },
  { href: '/reports',          label: 'Звіти',        icon: BarChart2,  roles: ['OWNER', 'ADMIN', 'ACCOUNTANT'] },
  { href: '/catalog',          label: 'Каталог',      icon: BookOpen,   roles: ['OWNER', 'ADMIN'] },
  { href: '/employees',        label: 'Персонал',     icon: UserCog,    roles: ['OWNER', 'ADMIN'] },
  { href: '/infrastructure',   label: 'Підрозділи',   icon: Building2,  roles: ['OWNER', 'ADMIN'] },
  { href: '/settings',         label: 'Налаштування', icon: Settings,   roles: ['OWNER', 'ADMIN'] },
  { href: '/settings/sync',    label: 'Cloud Sync',   icon: CloudUpload, roles: ['OWNER', 'ADMIN'] },
];

const SIDEBAR_COLLAPSED_KEY = 'sto_sidebar_collapsed';

function isActive(pathname: string, href: string): boolean {
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname.startsWith(href);
}

export function TopShell({ children }: { children: React.ReactNode }) {
  const { employee, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Load collapsed state from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      if (saved !== null) setCollapsed(saved === 'true');
    } catch {
      /* ignore */
    }
  }, []);

  // Close mobile sidebar on navigation
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  if (!employee) return <>{children}</>;

  const role = employee.role;
  const visibleNav = NAV.filter(n => !n.roles || n.roles.includes(role));

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const handleLogout = () => {
    if (confirm('Вийти з системи?')) {
      logout();
      router.push('/login');
    }
  };

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Logo + collapse toggle */}
      <div className={cn(
        'flex items-center gap-2 px-3 h-14 border-b border-sidebar-border shrink-0',
        collapsed ? 'justify-center' : 'justify-between',
      )}>
        {!collapsed && (
          <Link href="/dashboard" className="flex items-center gap-2 min-w-0">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-blue-500 shrink-0">
              <Wrench className="h-4 w-4 text-white" />
            </div>
            <span className="text-sm font-bold text-white tracking-tight truncate">STO ERP</span>
          </Link>
        )}
        {collapsed && (
          <Link href="/dashboard">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-blue-500">
              <Wrench className="h-4 w-4 text-white" />
            </div>
          </Link>
        )}
        <button
          onClick={toggleCollapsed}
          className="hidden lg:flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:text-white hover:bg-white/10 transition-colors shrink-0"
          title={collapsed ? 'Розгорнути' : 'Згорнути'}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-2">
        {visibleNav.map(item => {
          const active = isActive(pathname ?? '', item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={cn(
                'flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm font-medium transition-colors mb-0.5',
                collapsed ? 'justify-center' : '',
                active
                  ? 'bg-white/15 text-white'
                  : 'text-gray-300 hover:bg-white/10 hover:text-white',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* User section */}
      <div className={cn(
        'border-t border-sidebar-border px-2 py-3 shrink-0',
      )}>
        {!collapsed ? (
          <div className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-500 text-white text-xs font-bold shrink-0">
              {employee.firstName?.[0]?.toUpperCase() ?? '?'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-white truncate">
                {employee.firstName} {employee.lastName}
              </div>
              <div className="text-xs text-gray-400 truncate">{role}</div>
            </div>
            <button
              onClick={handleLogout}
              className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
              title="Вийти"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-500 text-white text-xs font-bold">
              {employee.firstName?.[0]?.toUpperCase() ?? '?'}
            </div>
            <button
              onClick={handleLogout}
              className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
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
    <div className="flex h-screen overflow-hidden bg-gray-50">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          'hidden lg:flex flex-col flex-shrink-0 bg-gray-900 transition-all duration-200',
          collapsed ? 'w-[56px]' : 'w-[220px]',
        )}
      >
        <SidebarContent />
      </aside>

      {/* Mobile sidebar overlay */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/40 z-40 lg:hidden"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside className="fixed inset-y-0 left-0 w-[220px] flex flex-col bg-gray-900 z-50 lg:hidden">
            <SidebarContent />
          </aside>
        </>
      )}

      {/* Main content */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Mobile topbar */}
        <header className="flex lg:hidden items-center gap-3 px-4 h-12 bg-white border-b border-gray-200 shrink-0">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-600 transition-colors"
            aria-label="Відкрити меню"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-600">
              <Wrench className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="text-sm font-bold text-gray-900">STO ERP</span>
          </Link>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
