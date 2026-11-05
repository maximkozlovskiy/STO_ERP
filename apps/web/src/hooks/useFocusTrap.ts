'use client';

import { useEffect, useRef, type RefObject } from 'react';

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
 *  3. при закритті фокус повертається на елемент, що був активним до відкриття (кнопка, що
 *     відкрила вікно), — якщо він ще в документі й бере фокус; інакше на верхню з пасток, що
 *     лишились (нижня модалка).
 *
 * Елемент «до відкриття» запам'ятовується в РЕНДЕРІ, на якому `active` став true, а не в ефекті:
 * поле з `autoFocus` бере фокус на коміті, ДО ефекту, і ефект запам'ятовував саме його — поле
 * всередині панелі. Закриття тоді «повертало» фокус на поле, що зникло разом із панеллю, і фокус
 * падав на `<body>` (вікно вибору товарів → Escape, TECH-DEBT §8 L697).
 *
 * Вкладені модалки: кожен екземпляр трапить ВЛАСНУ панель і позначає її `data-focus-trap`.
 * Слухачі обох висять на document, і нижня модалка чує Tab першою: якщо фокус у панелі ІНШОЇ
 * пастки, нижня мусить відступити. Без цього вона «повертала втікача» на свій край, верхня —
 * на свій, і Tab у вкладеній модалці завжди стрибав на її першу кнопку («Закрити»), а решта
 * елементів була недосяжна з клавіатури.
 * Скоуп через containerRef (як існуючі keydown-хендлери Modal).
 */

/** Активні пастки в порядку відкриття — щоб після закриття верхньої віддати фокус нижній. */
const openTraps: HTMLElement[] = [];

const focusablesIn = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    el => el.offsetParent !== null || el === document.activeElement,
  );

/** Фокус «загубився»: стоїть на `<body>` (елемент у фокусі прибрали з DOM) або ніде. */
const focusLost = (): boolean =>
  document.activeElement === null || document.activeElement === document.body;

/**
 * Повертає фокус після закриття пастки: на елемент до відкриття, якщо він ще в документі й бере
 * фокус; інакше — у верхню з пасток, що лишились.
 */
function restoreFocus(target: HTMLElement | null): void {
  if (target?.isConnected) {
    target.focus?.();
    if (document.activeElement === target) return;
  }
  // Нижня модалка, що закривається в тому ж коміті, уже поза документом — її пропускаємо.
  const lower = [...openTraps].reverse().find(el => el.isConnected);
  if (!lower) return;
  const first = focusablesIn(lower)[0];
  if (first) first.focus();
  else {
    lower.setAttribute('tabindex', '-1');
    lower.focus();
  }
}

export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean): void {
  // Елемент у фокусі ДО відкриття — береться в рендері переходу active false → true (див. вище).
  const openerRef = useRef<HTMLElement | null>(null);
  const wasActiveRef = useRef(false);
  if (active && !wasActiveRef.current && typeof document !== 'undefined') {
    const el = document.activeElement;
    openerRef.current = el instanceof HTMLElement && el !== document.body ? el : null;
  }
  wasActiveRef.current = active;

  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const container = containerRef.current;
    if (!container) return;

    container.setAttribute(TRAP_ATTR, '');
    openTraps.push(container);

    const opener = openerRef.current;

    const focusables = (): HTMLElement[] => focusablesIn(container);

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
      const index = openTraps.indexOf(container);
      if (index !== -1) openTraps.splice(index, 1);
      // Повертаємо фокус, лише якщо він досі в нашій панелі або загубився (панель уже прибрано
      // з DOM разом із полем у фокусі). Фокус, який легітимно взяв інший елемент (вкладена
      // модалка, сусідня картка), не відбираємо.
      if (container.contains(document.activeElement) || focusLost()) restoreFocus(opener);
    };
  }, [active, containerRef]);
}
