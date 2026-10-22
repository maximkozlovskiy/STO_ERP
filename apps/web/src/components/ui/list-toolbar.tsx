import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface ListStatusRowProps {
  /** Кнопки статусів (`StatusPill`) — ліворуч, переносяться на вузькому екрані. */
  children: ReactNode;
  /**
   * Доступна назва групи кнопок («Статус», «Стан»). Без неї група не має ролі: читач екрана
   * прочитав би кнопки статусів як окремі, без зв'язку з фільтром.
   */
  label?: string;
  /** Перемикачі праворуч від статусів («Мої наряди»). */
  right?: ReactNode;
}

/**
 * Рядок статусів списку документів — над рядком фільтрів, під збереженими поданнями
 * (стандарт списку, `docs/PATTERNS.md` «Панель списку»). Класи збігаються з еталоном нарядів:
 * на `div.flex.gap-1\.5.flex-wrap.items-center >> button` спирається E2E нарядів.
 */
export function ListStatusRow({ children, label, right }: ListStatusRowProps) {
  return (
    <div className="flex gap-1.5 flex-wrap items-center justify-between shrink-0">
      <div
        className="flex gap-1.5 flex-wrap items-center"
        role={label ? 'group' : undefined}
        aria-label={label}
      >
        {children}
      </div>
      {right}
    </div>
  );
}

interface ListFiltersRowProps {
  /** Пошук (`w-72 h-8`), дати, випадаючі фільтри — ліворуч у порядку важливості. */
  children: ReactNode;
  /**
   * Дії праворуч: «видалені», збереження подання, колонки, бокова панель, основна кнопка
   * «+ Документ» — саме в такому порядку.
   */
  actions?: ReactNode;
  className?: string;
}

/**
 * Рядок фільтрів списку — під рядком статусів, над масовими діями й таблицею. Дії притиснуті
 * праворуч (`ml-auto`) і на вузькому екрані переносяться разом, а не по одній кнопці.
 */
export function ListFiltersRow({ children, actions, className }: ListFiltersRowProps) {
  return (
    <div className={cn('flex flex-wrap items-center gap-3 shrink-0', className)}>
      {children}
      {actions && <div className="flex items-center gap-2 ml-auto">{actions}</div>}
    </div>
  );
}
