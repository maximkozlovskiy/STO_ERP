import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';

interface DocLinesHeaderProps {
  /** Назва табличної частини: «Товари», «Позиції». */
  title: string;
  /** Немає → кнопки «Додати» немає (картка лише на перегляд або рядок уже вводиться). */
  onAdd?: () => void;
  /** Інші дії табличної частини (імпорт тощо) — стоять ліворуч від «Додати». */
  children?: ReactNode;
}

/**
 * Стандарт шапки табличної частини документа (еталон — «Товари / Запчастини» в картці наряду):
 * назва ліворуч, «+ Додати» праворуч НАД таблицею. Кнопка під таблицею — відхилення від стандарту.
 */
export function DocLinesHeader({ title, onAdd, children }: DocLinesHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-2">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <div className="flex items-center gap-2">
        {children}
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Додати
          </button>
        )}
      </div>
    </div>
  );
}
