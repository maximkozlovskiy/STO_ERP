'use client';

import { useLayoutEffect, useRef, type RefObject } from 'react';
import { nextEscapeLayerOrder, registerEscapeLayer } from '@/lib/escape-layers';

/**
 * Поки `active`, шар у стеку Escape (`lib/escape-layers`): Escape отримує лише верхній шар —
 * той, що відкрили останнім. `<Modal>` уже шар; хук потрібен попапам, випадним спискам, меню й
 * полям у режимі редагування, щоб Escape закривав їх, а не вікно під ними.
 *
 * Прапорці «вкладене відкрито» у власника більше не потрібні: Escape вкладеного вікна до нього
 * просто не доходить.
 *
 * `scopeRef` — шар реагує лише на Escape зсередини елемента (див. `EscapeLayer.scopeRef`).
 */
export function useEscapeLayer(
  active: boolean,
  onEscape: () => void,
  scopeRef?: RefObject<HTMLElement | null>,
): void {
  // onEscape зазвичай інлайн-стрілка — у ref, щоб не перереєструвати шар на кожен рендер.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  // Порядок береться в РЕНДЕРІ, а не в ефекті: рендер іде від батька до дитини, ефекти — навпаки.
  // Вікно й вкладений попап, відкриті одним кліком, інакше стали б у стек батьком догори.
  const orderRef = useRef(0);
  if (!active) orderRef.current = 0;
  else if (orderRef.current === 0) orderRef.current = nextEscapeLayerOrder();

  // Layout-ефект, а не звичайний: шар мусить бути в стеку вже на коміті, до першого кадру. Пасивний
  // ефект оновлення не з події (підтвердження після відповіді сервера) виконується ПІСЛЯ відмальовки —
  // у цьому вікні видимий діалог ще не шар, і Escape закрив би вікно під ним.
  useLayoutEffect(() => {
    if (!active) return;
    return registerEscapeLayer({ order: orderRef.current, onEscape: onEscapeRef, scopeRef });
  }, [active, scopeRef]);
}
