'use client';

import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href],area[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),iframe,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

const TRAP_ATTR = 'data-focus-trap';

/** Поля введення, куди ставиться початковий фокус вікна (не прапорці, не лише-читання). */
const FIELD =
  'input:not([disabled]):not([readonly]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="button"]):not([type="submit"]),select:not([disabled]),textarea:not([disabled]):not([readonly])';

/**
 * E2 — focus-trap для модалок (a11y WCAG 2.4.3 / 2.1.2). Поки модалка відкрита:
 *  1. фокус переміщується всередину панелі (перше поле введення, інакше перший фокусований
 *     елемент, або сама панель);
 *  2. Tab/Shift+Tab циклять У МЕЖАХ панелі (фокус не «тікає» на фон);
 *  3. при закритті фокус повертається на елемент, що був активним до відкриття.
 *
 * Вкладені модалки: кожен екземпляр трапить ВЛАСНУ панель і позначає її `data-focus-trap`.
 * Слухачі обох висять на document, і нижня модалка чує Tab першою: якщо фокус у панелі ІНШОЇ
 * пастки, нижня мусить відступити. Без цього вона «повертала втікача» на свій край, верхня —
 * на свій, і Tab у вкладеній модалці завжди стрибав на її першу кнопку («Закрити»), а решта
 * елементів була недосяжна з клавіатури.
 * Скоуп через containerRef (як існуючі keydown-хендлери Modal).
 */

export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const container = containerRef.current;
    if (!container) return;

    container.setAttribute(TRAP_ATTR, '');

    // Запам'ятовуємо елемент, що мав фокус до відкриття — щоб повернути на закритті.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        el => el.offsetParent !== null || el === document.activeElement,
      );

    // Початковий фокус (UX-огляд 2026-10-29: стояв на «×» шапки): елемент з `data-autofocus`; поле,
    // що вже взяло фокус (`autoFocus`); перше поле введення; інакше перший фокусований елемент або
    // сама панель. Поле з попапом на фокус (дата) позначене `data-no-autofocus` — його не відкриваємо.
    const focusedNow = document.activeElement as HTMLElement | null;
    const visible = (el: HTMLElement) => el.offsetParent !== null;
    const preferred =
      container.querySelector<HTMLElement>('[data-autofocus]:not([disabled])') ??
      (focusedNow && focusedNow !== container && container.contains(focusedNow)
        ? focusedNow
        : null) ??
      Array.from(container.querySelectorAll<HTMLElement>(FIELD)).find(
        el => visible(el) && !el.closest('[data-no-autofocus]'),
      );
    const initial = preferred ?? focusables()[0];
    if (initial) {
      initial.focus();
    } else {
      container.setAttribute('tabindex', '-1');
      container.focus();
    }

    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      // Фокус у панелі іншої (верхньої) пастки — це її Tab, не наш.
      const owner = document.activeElement?.closest(`[${TRAP_ATTR}]`);
      if (owner && owner !== container && !container.contains(owner)) return;
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
      container.removeAttribute(TRAP_ATTR);
      // Повертаємо фокус лише якщо він досі всередині нашої панелі (інакше не відбираємо
      // фокус у того, хто його вже легітимно отримав, напр. вкладена модалка).
      if (previouslyFocused && container.contains(document.activeElement)) {
        previouslyFocused.focus?.();
      }
    };
  }, [active, containerRef]);
}
