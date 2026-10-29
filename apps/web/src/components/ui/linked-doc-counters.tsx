'use client';

import type { ElementType } from 'react';

/** Лічильник пов'язаних документів у рядку списку: поле лічильника, іконка, ключ підпису. */
export interface DocCounterDef<F extends string> {
  field: F;
  Icon: ElementType;
  labelKey: string;
}

interface LinkedDocCountersProps<F extends string> {
  counters: ReadonlyArray<DocCounterDef<F>>;
  /** Лічильники рядка; `undefined` — ще не завантажені (нічого не показуємо). */
  counts: Partial<Record<F, number>> | undefined;
  /** Відкрити вікно «Пов'язані документи» цього рядка. */
  onOpen: () => void;
  /** Переклад ключа підпису (простір імен — сторінки, що задала `counters`). */
  label: (key: string) => string;
}

/**
 * Колонка «Пов'язані документи» списку: іконка з числом на кожен ненульовий лічильник, клік
 * відкриває вікно пов'язаних документів. Одна розмітка для нарядів і рахунків.
 */
export function LinkedDocCounters<F extends string>({
  counters,
  counts,
  onOpen,
  label,
}: LinkedDocCountersProps<F>) {
  return (
    <div className="flex gap-1.5 items-center text-xs text-muted-foreground">
      {counters.map(({ field, Icon, labelKey }) => {
        const n = counts?.[field];
        if (!n) return null;
        return (
          <button
            key={field}
            type="button"
            onClick={onOpen}
            className="flex items-center gap-0.5 hover:text-foreground transition-colors"
            title={`${label(labelKey)}: ${n}`}
          >
            <Icon size={13} />
            <span>{n}</span>
          </button>
        );
      })}
    </div>
  );
}
