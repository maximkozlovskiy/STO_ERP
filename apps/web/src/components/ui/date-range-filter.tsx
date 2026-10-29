'use client';

import { useTranslation } from 'react-i18next';
import { DatePickerInput } from './date-picker-input';

interface DateRangeFilterProps {
  /** Межі періоду, `YYYY-MM-DD`; порожній рядок — межу не задано. */
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  /** Підписи «З» / «По» — видимий текст і доступна назва поля водночас (типово — спільні). */
  fromLabel?: string | undefined;
  toLabel?: string | undefined;
}

/**
 * Відбір «З … По …» у рядку фільтрів списку документів (складські документи, оплати, банк, каса).
 *
 * Одна розмітка на всі списки: підпис ліворуч від поля, межі обмежують одна одну (`max`/`min`),
 * кожну межу можна зняти кнопкою «×» (порожня межа = «без обмеження»),
 * і кожне поле має доступну назву. Підпис-`span` сам із полем не пов'язаний, тож без `ariaLabel`
 * читач екрана називав обидва поля однаково — «ДД.ММ.РРРР».
 *
 * Рендерить фрагмент із двох блоків — стає в наявний `flex`-рядок фільтрів без власної обгортки.
 */
export function DateRangeFilter({
  from,
  to,
  onFromChange,
  onToChange,
  fromLabel: fromLabelProp,
  toLabel: toLabelProp,
}: DateRangeFilterProps) {
  const { t } = useTranslation('common');
  const fromLabel = fromLabelProp ?? t('dateRange.from');
  const toLabel = toLabelProp ?? t('dateRange.to');
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-muted-foreground shrink-0">{fromLabel}</span>
        <DatePickerInput
          value={from}
          onChange={onFromChange}
          max={to || undefined}
          ariaLabel={fromLabel}
          clearable
          className="w-40"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-muted-foreground shrink-0">{toLabel}</span>
        <DatePickerInput
          value={to}
          onChange={onToChange}
          min={from || undefined}
          ariaLabel={toLabel}
          clearable
          className="w-40"
        />
      </div>
    </>
  );
}
