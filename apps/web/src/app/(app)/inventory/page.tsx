'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Маршрут /inventory тепер — вкладка «Залишки» на сторінці «Склад» (stock-documents).
 * Redirect, щоб старі посилання/закладки/command-palette/shortcuts не ламались.
 */
export default function InventoryRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/stock-documents?tab=stock');
  }, [router]);
  return null;
}
