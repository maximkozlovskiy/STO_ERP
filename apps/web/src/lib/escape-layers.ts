import type { RefObject } from 'react';

/**
 * Стек шарів Escape: одна клавіша закриває ЛИШЕ верхній шар (вікно, попап, випадний список,
 * поле в режимі редагування), а не все, що відкрито під ним.
 *
 * Один слухач `keydown` на document у capture-фазі вибирає верхній шар і зупиняє подію. До нього
 * кожен `<Modal>` слухав Escape сам, і картки тримали прапорці «над мною відкрито вкладене вікно»,
 * які доводилось знімати таймером: браузер рендерить між двома слухачами однієї події, і вікно під
 * вкладеним бачило вже знятий прапорець (GOTCHAS 2026-10-12, Bug #919–#933). Тут одна подія — одне
 * рішення, тож прапорці не потрібні.
 *
 * Реєструється через `useEscapeLayer` — напряму лише в тестах.
 */
export interface EscapeLayer {
  /** Порядок відкриття: більший — вище. Видає `nextEscapeLayerOrder()`. */
  order: number;
  onEscape: { readonly current: () => void };
  /**
   * Шар реагує лише на Escape зсередини цього елемента, для решти він «прозорий». Для списків,
   * що живуть у DOM поля: після Tab-у з поля Escape належить вікну, а не невидимому списку (Bug #922).
   */
  scopeRef?: RefObject<HTMLElement | null> | undefined;
}

const layers: EscapeLayer[] = [];
let lastOrder = 0;

export function nextEscapeLayerOrder(): number {
  lastOrder += 1;
  return lastOrder;
}

function topLayerFor(target: EventTarget | null): EscapeLayer | undefined {
  let top: EscapeLayer | undefined;
  for (const layer of layers) {
    if (top && layer.order < top.order) continue;
    if (layer.scopeRef) {
      const scope = layer.scopeRef.current;
      if (!scope || !(target instanceof Node) || !scope.contains(target)) continue;
    }
    top = layer;
  }
  return top;
}

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  // Escape під час набору через IME скасовує набір у полі — це не команда закрити шар.
  if (e.isComposing) return;
  const top = topLayerFor(e.target);
  if (!top) return;
  // Жоден інший слухач (зокрема React onKeyDown полів під шаром) цей Escape не отримує.
  e.stopImmediatePropagation();
  top.onEscape.current();
}

export function registerEscapeLayer(layer: EscapeLayer): () => void {
  layers.push(layer);
  if (layers.length === 1) document.addEventListener('keydown', handleKeyDown, true);
  return () => {
    const index = layers.indexOf(layer);
    if (index === -1) return;
    layers.splice(index, 1);
    if (layers.length === 0) document.removeEventListener('keydown', handleKeyDown, true);
  };
}

/** Кількість зареєстрованих шарів — для тестів. */
export function escapeLayerCount(): number {
  return layers.length;
}
