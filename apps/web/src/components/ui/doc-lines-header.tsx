'use client';

import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface DocLinesHeaderProps {
  /** Назва табличної частини: «Товари», «Позиції». */
  title: string;
  /** Немає → кнопки «Додати» немає (картка лише на перегляд або рядок уже вводиться). */
  onAdd?: () => void;
  /** Інші дії табличної частини (імпорт тощо) — стоять ліворуч від «Додати». */
  children?: ReactNode;
}

/**
 * Рядок-підказка порожньої табличної частини — той самий текст у всіх картках документів.
 * `canEdit: false` (проведений, видалений) → «Рядки відсутні»: кнопки «Додати» там немає.
 */
export function DocLinesEmptyRow({ colSpan, canEdit }: { colSpan: number; canEdit: boolean }) {
  const { t } = useTranslation('common');
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8 text-center text-[12px] text-muted-foreground">
        {canEdit ? t('docLines.emptyEditable') : t('docLines.empty')}
      </td>
    </tr>
  );
}

/**
 * Стандарт шапки табличної частини документа (рахунок, замовлення, складський документ):
 * назва ліворуч, «+ Додати» праворуч НАД таблицею. Кнопка під таблицею — відхилення від стандарту.
 */
export function DocLinesHeader({ title, onAdd, children }: DocLinesHeaderProps) {
  const { t } = useTranslation('common');
  return (
    // flex-wrap: на вузькому екрані дії (імпорт, Excel) переносяться під назву, а не виїжджають
    // за край картки разом із «Додати» (перевірено на 390 px).
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 mb-2">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <div className="flex flex-wrap items-center justify-end gap-2 ml-auto">
        {children}
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('add')}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Числова клітинка рядка, що вводиться (кількість, ціна) у табличній частині документа — одна
 * розмітка для рахунку й складського документа (CI-гейт нових клонів).
 */
export function DocNewLineNumberCell({
  value,
  onChange,
  min,
  step,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  min: string;
  step: string;
  placeholder?: string;
}) {
  return (
    <td className="px-2 py-1.5">
      <input
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-input bg-background px-2 py-1 text-[12px] text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
      />
    </td>
  );
}
