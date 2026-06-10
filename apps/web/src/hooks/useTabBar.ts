'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTabBarContext } from '@/contexts/TabBarContext';
import { MASTER_NAV_ITEMS } from '@/lib/nav';

export { useTabBarContext as useTabBarRaw };

export function useTabBar() {
  const ctx = useTabBarContext();
  const pathname = usePathname();
  const router = useRouter();
  const prevPathRef = useRef<string>('');

  // Auto-open page tab when route changes
  useEffect(() => {
    if (!pathname || pathname === prevPathRef.current) return;
    prevPathRef.current = pathname;

    // Skip non-app routes
    if (pathname === '/login' || pathname.startsWith('/setup')) return;

    // Find matching nav item (exact or prefix match, prefer longest)
    const match = MASTER_NAV_ITEMS.filter(
      i => pathname === i.href || pathname.startsWith(i.href + '/'),
    ).sort((a, b) => b.href.length - a.href.length)[0];

    if (match) {
      ctx.openPageTab(match.href, match.label);
      ctx.setActivePageId(match.href);
    }
  }, [pathname, ctx]);

  // Close tab: navigate to previous in history
  const closeTab = (id: string) => {
    const { tabs } = ctx;
    const idx = tabs.findIndex(t => t.id === id);
    ctx.closeTab(id);

    // If closing the currently active page tab → navigate to previous
    if (id === ctx.activePageId) {
      // Find previous page tab (before current in list)
      const pageTabs = tabs.filter(t => t.kind === 'page' && t.id !== id);
      const target = pageTabs[Math.max(0, idx - 1)] ?? pageTabs[pageTabs.length - 1];
      router.push(target ? (target as { href: string }).href : '/dashboard');
    }
  };

  // Activate tab: navigate or restore modal
  const activateTab = (id: string) => {
    const tab = ctx.tabs.find(t => t.id === id);
    if (!tab) return;
    if (tab.kind === 'page') {
      router.push(tab.href);
    }
    // Modal restore is handled externally via restoreModal
  };

  return {
    ...ctx,
    closeTab,
    activateTab,
    pathname,
  };
}
