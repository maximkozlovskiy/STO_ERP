'use client';

import { DatePickerInput } from './date-picker-input';

interface DateRangeFilterProps {
  /** Межі періоду, `YYYY-MM-DD`; порожній рядок — межу не задано. */
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  /** Підписи «З» / «По» — видимий текст і доступна назва поля водночас. */
  fromLabel: string;
  toLabel: string;
}

/**
 * Відбір «З … По …» у рядку фільтрів списку документів (складські документи, оплати, банк, каса).
 *
 * Одна розмітка на всі списки: підпис ліворуч від поля, межі обмежують одна одну (`max`/`min`),
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
  fromLabel,
  toLabel,
}: DateRangeFilterProps) {
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-muted-foreground shrink-0">{fromLabel}</span>
        <DatePickerInput
          value={from}
          onChange={onFromChange}
          max={to || undefined}
          ariaLabel={fromLabel}
          className="w-36"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-muted-foreground shrink-0">{toLabel}</span>
        <DatePickerInput
          value={to}
          onChange={onToChange}
          min={from || undefined}
          ariaLabel={toLabel}
          className="w-36"
        />
      </div>
    </>
  );
}
