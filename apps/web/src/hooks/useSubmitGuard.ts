'use client';

import { useRef, useCallback } from 'react';

/**
 * Синхронний guard проти подвійного сабміту / подвійного кліку.
 *
 * Проблема, яку розв'язує: `useState`-прапорець (`if (loading) return`) оновлюється
 * лише на НАСТУПНОМУ ре-рендері React. Два синхронних кліки в одному tick (native
 * `.click()` ×2, або швидкий даблклік користувача) обидва читають старе значення
 * стану ДО перемалювання → обидва проходять guard → 2 мережеві запити (2 наряди/
 * рахунки/дублі). Клас багів #630 / #632-636.
 *
 * Ref фліпається СИНХРОННО (`ref.current = true`) у момент першого входу, тож другий
 * синхронний виклик у тому ж tick уже бачить `true` і відсікається. `disabled={...}`
 * на кнопці (через `useState`) лишається для візуального стану — але саме ref є
 * джерелом істини для гонки.
 *
 * Usage:
 *   const clone = useSubmitGuard();
 *   const handleClone = (wo) => clone.run(async () => {
 *     await apiFetch(`/work-orders/${wo.id}/clone`, { method: 'POST' });
 *   });
 *
 * `run` no-op'ить (повертає undefined), якщо попередній виклик ще in-flight.
 */
export function useSubmitGuard() {
  const inFlightRef = useRef(false);

  const run = useCallback(async (fn: () => Promise<void>): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      await fn();
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  /** Чи виконується зараз захищена операція (для читання у тесті/логіці, не для гонки). */
  const isRunning = useCallback(() => inFlightRef.current, []);

  return { run, isRunning };
}
