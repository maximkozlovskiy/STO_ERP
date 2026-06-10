'use client';

import { usePathname } from 'next/navigation';
import { useTabBarContext } from '@/contexts/TabBarContext';

export { useTabBarContext as useTabBarRaw };

export function useTabBar() {
  const ctx = useTabBarContext();
  const pathname = usePathname();

  // Close modal tab (no navigation side-effect needed)
  const closeTab = (id: string) => {
    ctx.closeTab(id);
  };

  // Activate modal tab → set pendingRestore
  const activateTab = (id: string) => {
    const tab = ctx.tabs.find(t => t.id === id);
    if (!tab || tab.kind !== 'modal') return;
    const modalTab = ctx.restoreModal(id);
    if (modalTab) ctx.setPendingRestore(modalTab);
  };

  return {
    ...ctx,
    closeTab,
    activateTab,
    pathname,
  };
}
