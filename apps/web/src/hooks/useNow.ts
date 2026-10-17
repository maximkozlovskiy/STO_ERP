'use client';

import { useEffect, useMemo, useState } from 'react';

/**
 * «Зараз», що оновлюється кожні `intervalMs`, поки компонент змонтовано. Тримати його в
 * найменшому компоненті, якому він потрібен: щохвилинне оновлення ре-рендерить лише його, а не
 * всю картку (напр. пікери планових дат наряду, BR-WO-019).
 */
export function useNow(intervalMs: number): Date {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return useMemo(() => new Date(nowMs), [nowMs]);
}
