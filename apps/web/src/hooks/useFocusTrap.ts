'use client';

import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href],area[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),iframe,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

/**
 * E2 — focus-trap для модалок (a11y WCAG 2.4.3 / 2.1.2). Поки модалка відкрита:
 *  1. фокус переміщується всередину панелі (перший фокусований елемент, або сама панель);
 *  2. Tab/Shift+Tab циклять У МЕЖАХ панелі (фокус не «тікає» на фон);
 *  3. при закритті фокус повертається на елемент, що був активним до відкриття.
 *
 * Вкладені модалки: кожен екземпляр трапить ВЛАСНУ панель. Оскільки фокус тримається у панелі
 * верхньої (останньо відкритої) модалки, а нижня прихована під backdrop — конфлікту немає.
 * Скоуп через containerRef (як існуючі keydown-хендлери Modal).
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const container = containerRef.current;
    if (!container) return;

    // Запам'ятовуємо елемент, що мав фокус до відкриття — щоб повернути на закритті.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        el => el.offsetParent !== null || el === document.activeElement,
      );

    // Початковий фокус — перший фокусований елемент або сама панель (робимо її фокусованою).
    const initial = focusables()[0];
    if (initial) {
      initial.focus();
    } else {
      container.setAttribute('tabindex', '-1');
      container.focus();
    }

    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        // Немає фокусованих — тримаємо фокус на панелі.
        e.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement;
      // Якщо фокус поза панеллю (втік) — повертаємо на край.
      if (!container.contains(activeEl)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      // Повертаємо фокус лише якщо він досі всередині нашої панелі (інакше не відбираємо
      // фокус у того, хто його вже легітимно отримав, напр. вкладена модалка).
      if (previouslyFocused && container.contains(document.activeElement)) {
        previouslyFocused.focus?.();
      }
    };
  }, [active, containerRef]);
}
