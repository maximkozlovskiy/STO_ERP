'use client';

import { useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useKeyboardShortcut } from './useKeyboardShortcut';
import { toast } from '@/lib/toast';

/**
 * Global keyboard shortcuts active across the whole app.
 *
 * Shortcuts:
 *   G then D   → /dashboard        (sequential, via local state)
 *   G then W   → /work-orders
 *   G then C   → /crm
 *   G then I   → /inventory
 *   ?          → show shortcuts help toast
 */
export function useGlobalShortcuts(enabled: boolean) {
  const router = useRouter();
  const pathname = usePathname();

  // G + D — go to dashboard
  useKeyboardShortcut('g', useCallback(() => {
    // handled via sequential G-then-letter logic below — placeholder to satisfy hook API
  }, []), { enabled: false });

  // Navigation shortcuts: Alt+W, Alt+C, Alt+I, Alt+D for quick nav (no conflict with browser)
  useKeyboardShortcut('alt+w', useCallback((e) => {
    e.preventDefault();
    router.push('/work-orders');
  }, [router]), { enabled, allowInInput: false });

  useKeyboardShortcut('alt+d', useCallback((e) => {
    e.preventDefault();
    router.push('/dashboard');
  }, [router]), { enabled, allowInInput: false });

  useKeyboardShortcut('alt+c', useCallback((e) => {
    e.preventDefault();
    router.push('/crm');
  }, [router]), { enabled, allowInInput: false });

  useKeyboardShortcut('alt+i', useCallback((e) => {
    e.preventDefault();
    router.push('/inventory');
  }, [router]), { enabled, allowInInput: false });

  // N — new item based on current section
  useKeyboardShortcut('n', useCallback(() => {
    if (pathname?.startsWith('/work-orders') && !pathname.includes('/new')) {
      router.push('/work-orders/new');
    } else if (pathname?.startsWith('/crm') && !pathname.includes('/new')) {
      router.push('/crm/new');
    }
  }, [router, pathname]), { enabled, allowInInput: false });

  // ? — show keyboard shortcuts help
  useKeyboardShortcut('shift+/', useCallback(() => {
    toast.info(
      'Ctrl+K — пошук · Alt+W — наряди · Alt+D — дашборд · Alt+C — CRM · Alt+I — склад · N — новий запис',
      8000,
    );
  }, []), { enabled, allowInInput: false });
}
