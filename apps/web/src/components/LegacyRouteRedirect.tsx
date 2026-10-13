'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Перенаправлення зі старої адреси сторінки, якої більше немає (закладки, історія браузера,
 * посилання в листуванні). Застосунок — статичний експорт (`output: 'export'`), серверних
 * redirect-ів немає, тому сторінка-оболонка лишається й одразу веде на нову адресу.
 * `replace`, а не `push`: «Назад» не має повертати на адресу, яка знову перекине вперед.
 */
export function LegacyRouteRedirect({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(to);
  }, [router, to]);
  return null;
}
