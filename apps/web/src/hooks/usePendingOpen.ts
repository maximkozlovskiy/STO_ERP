'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEscapeLayer } from '@/hooks/useEscapeLayer';

/**
 * Вкладене вікно, що відкривається ПІСЛЯ запиту («Відкрити картку» товару чи контрагента з
 * вікна-власника): спершу дані, потім `open`. Поки запит у дорозі, вікна ще немає в стеку Escape —
 * Escape закрив би вікно-власника, а картка, що приходить слідом, відкрилась би сама над списком
 * (Bug #935).
 *
 * `openAfter(load, show)` робить завантаження шаром Escape: Escape скасовує відкриття, вікно-власник
 * лишається. Вікно-власник, закрите тим часом (×, клік поза вікном), відкриття теж скасовує. Помилка
 * скасованого завантаження мовчить; нескасованого — летить до виклику, як і без хука.
 */
export function usePendingOpen(ownerOpen: boolean) {
  const [pending, setPending] = useState(false);
  const runRef = useRef(0);

  const cancel = useCallback(() => {
    runRef.current += 1;
    setPending(false);
  }, []);

  useEscapeLayer(pending, cancel);

  useEffect(() => {
    if (!ownerOpen) cancel();
  }, [ownerOpen, cancel]);

  return useCallback(async <T>(load: () => Promise<T>, show: (data: T) => void): Promise<void> => {
    runRef.current += 1;
    const run = runRef.current;
    setPending(true);
    try {
      const data = await load();
      if (run === runRef.current) show(data);
    } catch (e: unknown) {
      if (run === runRef.current) throw e;
    } finally {
      if (run === runRef.current) setPending(false);
    }
  }, []);
}
