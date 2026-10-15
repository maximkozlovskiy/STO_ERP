'use client';

import { useTranslation } from 'react-i18next';
import {
  CATEGORY_VIEW,
  SLOT_CATEGORIES,
  countCategories,
  type CategoryInput,
} from './calendar-categories';

interface CalendarCategoryCountersProps {
  /** Записи дня з кінцем ЛАНЦЮЖКА в `endMs` (див. `buildMonthSlots`). */
  entries: readonly CategoryInput[];
  nowMs: number;
  testId: string;
  /** `sm` — клітинка місяця; `md` — смуга навігації виду «День». */
  size?: 'sm' | 'md';
}

const SIZE = {
  sm: { row: 'self-start gap-x-2 px-1 py-0.5 text-[11px]', icon: 'h-3 w-3' },
  md: {
    row: 'self-center gap-x-3 border border-border px-2 py-1 text-[13px]',
    icon: 'h-3.5 w-3.5',
  },
} as const;

/**
 * Рядок лічильників записів дня за категоріями (BR-CAL-008): іконка й число кожної непорожньої
 * категорії. Той самий рядок — у клітинці виду «Місяць» і в смузі виду «День».
 */
export function CalendarCategoryCounters({
  entries,
  nowMs,
  testId,
  size = 'sm',
}: CalendarCategoryCountersProps) {
  const { t } = useTranslation('calendar');
  const counts = countCategories(entries, nowMs);
  const shown = SLOT_CATEGORIES.filter(c => (counts[c] ?? 0) > 0);
  if (shown.length === 0) return null;
  return (
    <span
      // Підкладка `bg-surface`: на насиченому фоні завантаженості кольори
      // категорій без неї падають нижче 3:1 (світла тема, 50% primary).
      className={`flex flex-wrap items-center gap-y-1 rounded bg-surface font-medium leading-none tabular-nums ${SIZE[size].row}`}
      data-testid={testId}
    >
      {shown.map(c => {
        const { icon: Icon, className: color } = CATEGORY_VIEW[c];
        const label = `${t(`month.category.${c}`)}: ${counts[c]}`;
        return (
          <span
            key={c}
            className={`inline-flex items-center gap-0.5 ${color}`}
            // role="img": aria-label на `span` без ролі читачі екрана
            // ігнорують — звучало б лише «2» без назви категорії.
            role="img"
            title={label}
            aria-label={label}
            data-category={c}
          >
            <Icon className={`${SIZE[size].icon} shrink-0`} aria-hidden="true" />
            {counts[c]}
          </span>
        );
      })}
    </span>
  );
}
