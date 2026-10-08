'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Маршрут /inventory тепер — вкладка «Залишки» у «Звітах» (/reports?tab=inventory).
 * Redirect, щоб старі посилання/закладки/command-palette/shortcuts не ламались.
 */
export default function InventoryRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/reports?tab=inventory');
  }, [router]);
  return null;
}
