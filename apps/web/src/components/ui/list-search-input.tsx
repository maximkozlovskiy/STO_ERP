'use client';

import { Search } from 'lucide-react';
import { LIST_SEARCH_MAX_LENGTH } from '@/lib/utils';
import { DateRangeFilter } from './date-range-filter';
import { Input } from './input';

interface ListSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Підказка в порожньому полі й доступна назва водночас (видимого підпису поле не має). */
  label: string;
  /** Ширина замість типової `w-72` — лише коли рядок фільтрів інакше не вміщається (каса). */
  widthClassName?: string;
}

/**
 * Поле пошуку в рядку фільтрів списку документів (складські документи, рухи, оплати, банк, каса).
 *
 * Одна розмітка на всі списки: лупа ліворуч, ширина й висота рядка фільтрів, довжина тексту
 * обмежена тим самим `LIST_SEARCH_MAX_LENGTH`, до якого пошук обрізає або який перевіряє API.
 */
export function ListSearchInput({
  value,
  onChange,
  label,
  widthClassName = 'w-72',
}: ListSearchInputProps) {
  return (
    <Input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={label}
      aria-label={label}
      maxLength={LIST_SEARCH_MAX_LENGTH}
      leftElement={<Search />}
      title={label}
      className={`${widthClassName} h-8 text-[13px]`}
    />
  );
}

/** Значення поля фільтра і його сеттер стану (`[value, setValue]`). */
type FilterField = readonly [string, (value: string) => void];

interface ListSearchPeriodProps {
  /** Стан списку (`useListPage()`): зміна поля — через `filterSetter` (перша сторінка, без подання). */
  list: { filterSetter: <T>(set: (value: T) => void) => (value: T) => void };
  /** Підказка й доступна назва поля пошуку. */
  label: string;
  search: FilterField;
  /** Межі періоду «З … По …», `YYYY-MM-DD`. */
  from: FilterField;
  to: FilterField;
}

/**
 * Пошук і період у рядку фільтрів списку документів (рахунки, наряди, замовлення, складські
 * документи) — у цьому порядку, як вимагає стандарт списку.
 */
export function ListSearchPeriod({ list, label, search, from, to }: ListSearchPeriodProps) {
  const { filterSetter } = list;
  return (
    <>
      <ListSearchInput value={search[0]} onChange={filterSetter(search[1])} label={label} />
      <DateRangeFilter
        from={from[0]}
        to={to[0]}
        onFromChange={filterSetter(from[1])}
        onToChange={filterSetter(to[1])}
      />
    </>
  );
}
