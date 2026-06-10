'use client';

import { useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { useTabBarContext } from '@/contexts/TabBarContext';

export { useTabBarContext as useTabBarRaw };

export function useTabBar() {
  const ctx = useTabBarContext();
  // Destructure для exhaustive-deps — lint потребує цілий ctx або поіменовані поля
  // у deps; деструктуризація дозволяє deps бути конкретними і стабільними.
  const { closeTab: ctxCloseTab, restoreModal, setPendingRestore } = ctx;
  const pathname = usePathname();

  // Bug #424: stable references — без useCallback кожен render TabBar створював
  // нові інлайн-arrow-функції у `.map()` → React.memo на TabChip ламався → всі chip-и
  // re-render-или навіть коли змінювалася лише одна tab. Тепер handler залежить лише
  // від ctx.closeTab/setPendingRestore/restoreModal, які мають стабільні reference
  // (useCallback у TabBarContext + ref-based restoreModal — Bug #425).
  const closeTab = useCallback(
    (id: string) => {
      ctxCloseTab(id);
    },
    [ctxCloseTab],
  );

  // Activate modal tab → set pendingRestore. `restoreModal` достатньо: воно повертає
  // null якщо id невалідний. Окрема `find` зайва.
  const activateTab = useCallback(
    (id: string) => {
      const modalTab = restoreModal(id);
      if (modalTab && modalTab.kind === 'modal') setPendingRestore(modalTab);
    },
    [restoreModal, setPendingRestore],
  );

  return {
    ...ctx,
    closeTab,
    activateTab,
    pathname,
  };
}
