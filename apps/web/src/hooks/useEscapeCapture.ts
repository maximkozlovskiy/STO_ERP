'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Escape закриває ЛИШЕ верхній шар (випадний список, календар, попап, діалог-підтвердження), а не
 * вікно під ним. `<Modal>` слухає Escape на document у bubble-фазі, тож перехоплюємо раніше —
 * у capture-фазі — і `stopImmediatePropagation` (Bug #783/#919/#920).
 *
 * `scopeRef` — реагувати лише на Escape зсередини цього елемента. Потрібен там, де шар живе в
 * DOM поля (списки пошуку): інакше невидимий для користувача відкритий список «ковтав» перший
 * Escape у вкладеному вікні, відкритому кнопкою «…», чи після Tab-у з поля (Bug #922). Для
 * попапів у порталі (календарі) — без нього: фокус там поза полем, а Escape мусить закрити попап.
 */
export function useEscapeCapture(
  active: boolean,
  onEscape: () => void,
  scopeRef?: RefObject<HTMLElement | null>,
): void {
  // onEscape зазвичай інлайн-стрілка — у ref, щоб не перевішувати слухача на кожен рендер.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (scopeRef && !(e.target instanceof Node && scopeRef.current?.contains(e.target))) return;
      e.stopImmediatePropagation();
      onEscapeRef.current();
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [active, scopeRef]);
}
