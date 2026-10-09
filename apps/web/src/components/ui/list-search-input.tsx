'use client';

import { Search } from 'lucide-react';
import { LIST_SEARCH_MAX_LENGTH } from '@/lib/utils';
import { Input } from './input';

interface ListSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Підказка в порожньому полі й доступна назва водночас (видимого підпису поле не має). */
  label: string;
}

/**
 * Поле пошуку в рядку фільтрів списку документів (складські документи, рухи, оплати, банк, каса).
 *
 * Одна розмітка на всі списки: лупа ліворуч, ширина й висота рядка фільтрів, довжина тексту
 * обмежена тим самим `LIST_SEARCH_MAX_LENGTH`, до якого пошук обрізає або який перевіряє API.
 */
export function ListSearchInput({ value, onChange, label }: ListSearchInputProps) {
  return (
    <Input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={label}
      aria-label={label}
      maxLength={LIST_SEARCH_MAX_LENGTH}
      leftElement={<Search />}
      className="w-64 h-8 text-[13px]"
    />
  );
}
