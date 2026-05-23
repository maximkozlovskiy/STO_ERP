'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

interface NavItem {
  href: string;
  label: string;
  icon: string;
  roles?: string[];
}

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Дашборд', icon: '◼' },
  { href: '/work-orders', label: 'Наряди', icon: '🔧' },
  { href: '/calendar', label: 'Календар', icon: '📅' },
  { href: '/crm', label: 'CRM', icon: '👥' },
  { href: '/inventory', label: 'Склад', icon: '📦' },
  { href: '/purchase-orders', label: 'Замовлення', icon: '🛒' },
  { href: '/stock-documents', label: 'Документи', icon: '📋' },
  { href: '/invoices', label: 'Рахунки', icon: '🧾' },
  { href: '/settlements', label: 'Розрахунки', icon: '💰' },
  { href: '/reports', label: 'Звіти', icon: '📊', roles: ['OWNER', 'ADMIN', 'ACCOUNTANT'] },
  { href: '/catalog', label: 'Каталог', icon: '📗', roles: ['OWNER', 'ADMIN'] },
  { href: '/employees', label: 'Персонал', icon: '👨‍🔧', roles: ['OWNER', 'ADMIN'] },
  { href: '/infrastructure', label: 'Підрозділи', icon: '🏢', roles: ['OWNER', 'ADMIN'] },
  { href: '/settings', label: 'Налаштування', icon: '⚙️', roles: ['OWNER', 'ADMIN'] },
  { href: '/settings/sync', label: 'Cloud Sync', icon: '☁️', roles: ['OWNER', 'ADMIN'] },
];

const QUICK_TABS_KEY = 'sto_quick_tabs';

export function TopShell({ children }: { children: React.ReactNode }) {
  const { employee, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [quickTabs, setQuickTabs] = useState<string[]>([]);

  // Load quick tabs from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(QUICK_TABS_KEY);
      if (saved) setQuickTabs(JSON.parse(saved));
    } catch {}
  }, []);

  // Track navigation → update quick tabs
  useEffect(() => {
    if (!pathname || pathname === '/dashboard') return;
    setQuickTabs(prev => {
      const updated = [pathname, ...prev.filter(t => t !== pathname)].slice(0, 6);
      localStorage.setItem(QUICK_TABS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, [pathname]);

  if (!employee) return <>{children}</>;

  const role = employee.role;
  const visibleNav = NAV.filter(n => !n.roles || n.roles.includes(role));

  // Sort by href length descending so /settings/sync matches before /settings
  const currentItem = [...NAV]
    .sort((a, b) => b.href.length - a.href.length)
    .find(n => pathname?.startsWith(n.href) && n.href !== '/dashboard')
    ?? NAV.find(n => n.href === pathname);

  const quickTabItems = quickTabs
    .map(href => NAV.find(n => n.href === href))
    .filter(Boolean) as NavItem[];

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* TopBar */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="flex items-center gap-3 px-4 h-12">
          {/* Logo */}
          <Link href="/dashboard" className="text-blue-600 font-bold text-lg tracking-tight mr-2">
            STO ERP
          </Link>

          {/* Hamburger menu */}
          <button onClick={() => setMenuOpen(!menuOpen)}
            className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          {/* Current section */}
          {currentItem && (
            <span className="text-sm font-medium text-gray-700 hidden sm:block">
              {currentItem.label}
            </span>
          )}

          <div className="flex-1" />

          {/* ViewToggle: Dashboard ↔ last workspace */}
          <div className="hidden sm:flex items-center bg-gray-100 rounded-lg p-0.5 mr-1">
            <Link href="/dashboard"
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                pathname === '/dashboard' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
              }`}>
              Дашборд
            </Link>
            <Link href={quickTabs[0] || '/work-orders'}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                pathname !== '/dashboard' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
              }`}>
              {quickTabItems[0]?.label || 'Наряди'}
            </Link>
          </div>

          {/* Quick tabs */}
          <div className="hidden md:flex gap-1">
            {quickTabItems.slice(0, 5).map(tab => (
              <Link key={tab.href} href={tab.href}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  pathname?.startsWith(tab.href) ? 'nav-active' : 'text-gray-500 hover:bg-gray-100'
                }`}>
                {tab.label}
              </Link>
            ))}
          </div>

          {/* User badge */}
          <div className="flex items-center gap-2 ml-2">
            <div className="text-right hidden sm:block">
              <div className="text-xs font-medium text-gray-900">{employee.firstName} {employee.lastName}</div>
              <div className="text-xs text-gray-400">{role}</div>
            </div>
            <button onClick={() => { if (confirm('Вийти з системи?')) { logout(); router.push('/login'); } }}
              className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
              title="Вийти">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* MegaMenu overlay */}
      {menuOpen && (
        <>
          <div className="fixed inset-0 bg-black/20 z-30" onClick={() => setMenuOpen(false)} />
          <div className="fixed top-12 left-0 w-64 bg-white border-r border-gray-200 shadow-xl z-40 h-[calc(100vh-48px)] overflow-y-auto">
            <nav className="p-2">
              {visibleNav.map(item => (
                <Link key={item.href} href={item.href}
                  onClick={() => setMenuOpen(false)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    pathname?.startsWith(item.href) && (item.href !== '/dashboard' || pathname === '/dashboard')
                      ? 'nav-active'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}>
                  <span className="text-base w-5 text-center">{item.icon}</span>
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </>
      )}

      {/* Content */}
      <main className="flex-1">
        {children}
      </main>
    </div>
  );
}
