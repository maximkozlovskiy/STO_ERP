'use client';

import { useTranslation } from 'react-i18next';
import {
  CATEGORY_VIEW,
  SLOT_CATEGORIES,
  SLOT_TYPES,
  SLOT_TYPE_ICON,
  TASK_VIEW,
} from './calendar-categories';
import { HelpPopover } from '@/components/ui/help-popover';

/**
 * Кнопка «?» у шапці календаря: пояснює іконки й кольори категорій записів і типи записів
 * виду «Місяць» (BR-CAL-008, BR-CAL-009). Поведінка вікна (Escape, клік поза ним, фокус) —
 * спільний `HelpPopover`.
 */
export function CalendarLegend() {
  const { t } = useTranslation('calendar');
  return (
    <HelpPopover label={t('month.legend.button')} title={t('month.legend.title')}>
      <div>
        <p className="mb-1 text-[12px] font-medium text-muted-foreground">
          {t('month.legend.categories')}
        </p>
        <ul className="mb-3 space-y-1.5">
          {SLOT_CATEGORIES.map(c => {
            const { icon: Icon, className, barClassName } = CATEGORY_VIEW[c];
            return (
              <li key={c} className="flex items-start gap-2" data-category={c}>
                <span
                  className={`mt-0.5 h-4 w-0 shrink-0 border-l-4 ${barClassName}`}
                  aria-hidden="true"
                />
                <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${className}`} aria-hidden="true" />
                <span className="min-w-0">
                  <span className="font-medium text-foreground">{t(`month.category.${c}`)}</span>
                  <span className="block text-[12px] text-muted-foreground">
                    {t(`month.legend.categoryHint.${c}`)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mb-1 text-[12px] font-medium text-muted-foreground">
          {t('month.legend.types')}
        </p>
        <ul className="grid grid-cols-2 gap-1.5">
          {SLOT_TYPES.map(type => {
            const Icon = SLOT_TYPE_ICON[type];
            return (
              <li key={type} className="flex items-center gap-2 text-foreground">
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                {t(`month.type.${type}`)}
              </li>
            );
          })}
        </ul>
        {/* Задача — окремий тип (BR-TASK-007): не категорія запису й не тип запису */}
        <p className="mt-3 mb-1 text-[12px] font-medium text-muted-foreground">
          {t('month.legend.tasks')}
        </p>
        <div className="flex items-start gap-2" data-legend="task">
          <span
            className={`mt-0.5 h-4 w-0 shrink-0 border-l-4 ${TASK_VIEW.barClassName.open}`}
            aria-hidden="true"
          />
          <TASK_VIEW.icon
            className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${TASK_VIEW.className}`}
            aria-hidden="true"
          />
          <span className="min-w-0">
            <span className="font-medium text-foreground">{t('month.legend.task')}</span>
            <span className="block text-[12px] text-muted-foreground">
              {t('month.legend.taskHint')}
            </span>
          </span>
        </div>
      </div>
    </HelpPopover>
  );
}
