import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

interface ListStatusRowProps {
  /** Кнопки статусів (`StatusPill`) — ліворуч, переносяться на вузькому екрані. */
  children: ReactNode;
  /**
   * Доступна назва групи кнопок («Статус», «Стан», «Розріз залишків»). Обов'язкова: без неї
   * читач екрана прочитав би кнопки як окремі, без зв'язку з фільтром.
   */
  label: string;
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
      <div className="flex gap-1.5 flex-wrap items-center" role="group" aria-label={label}>
        {children}
      </div>
      {right}
    </div>
  );
}

interface ListFiltersRowProps {
  /**
   * Пошук (`w-72 h-8`), дати, випадаючі фільтри — ліворуч у порядку важливості. Список без
   * фільтрів (зарплатні періоди) лишає рядок лише з діями.
   */
  children?: ReactNode;
  /**
   * Дії праворуч: «видалені», збереження подання, колонки, бокова панель, основна кнопка
   * «+ Документ» — саме в такому порядку.
   */
  actions?: ReactNode;
  className?: string;
}

/**
 * Рядок фільтрів списку — під рядком статусів, над масовими діями й таблицею. Дії притиснуті
 * праворуч (`ml-auto`) і на вузькому екрані переносяться разом, а не по одній кнопці. Група
 * ширша за рядок (каталог: 4 іконки + «Шаблон» + «Імпорт» + «+ Товар» ≈ 470 px при 358 px на
 * телефоні) переносить кнопки всередині себе (`flex-wrap`), а не виходить за вікно.
 */
export function ListFiltersRow({ children, actions, className }: ListFiltersRowProps) {
  return (
    <div className={cn('flex flex-wrap items-center gap-3 shrink-0', className)}>
      {children}
      {actions && (
        <div className="flex flex-wrap items-center justify-end gap-2 ml-auto">{actions}</div>
      )}
    </div>
  );
}

interface ShowDeletedToggleProps {
  /** Чи показані зараз видалені записи. */
  shown: boolean;
  onToggle: () => void;
}

/** Перемикач «показати видалені» в діях рядка фільтрів — перша кнопка праворуч. */
export function ShowDeletedToggle({ shown, onToggle }: ShowDeletedToggleProps) {
  const { t } = useTranslation('common');
  const label = shown ? t('deletedToggle.hide') : t('deletedToggle.show');
  return (
    <Button
      variant="outline"
      size="icon-sm"
      title={label}
      aria-label={label}
      aria-pressed={shown}
      onClick={onToggle}
      className={cn(shown && 'border-primary text-primary')}
    >
      {shown ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
    </Button>
  );
}
