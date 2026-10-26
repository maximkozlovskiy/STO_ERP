'use client';

import { useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useDebounce } from '@/hooks/useDebounce';
import {
  SUPPLIER_OPTIONS_PAGE,
  useSupplierOptions,
  type SupplierOption,
} from '@/hooks/api/useCounterparties';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

interface SupplierOptionsSelectProps {
  value: string;
  /**
   * Обраний постачальник — тримає ВЛАСНИК (отримує його в `onChange`): компонент додає його до
   * варіантів, коли той не в поточній сторінці чи результатах пошуку. У стані компонента він губився
   * при демонтажі (діалог після «Скасувати»), і `<select>` показував «— не змінювати —», хоча
   * значення лишалось (Bug #921).
   */
  selected: SupplierOption | null;
  /**
   * Ще один варіант, що лишається серед постачальників, коли він — поточне значення: власний
   * контрагент документа (підключення API), якого може не бути серед перших SUPPLIER_OPTIONS_PAGE
   * (Bug #894).
   */
  extraSelected?: SupplierOption | null;
  /** `option` — обраний постачальник; `null` для службових варіантів. */
  onChange: (id: string, option: SupplierOption | null) => void;
  /** Видимий підпис (діалог) — або лише `ariaLabel` (фільтр у рядку фільтрів). */
  label?: string;
  ariaLabel?: string;
  /** `id` списку; поле пошуку отримує `${id}-search`. */
  id?: string;
  required?: boolean;
  /** Службові варіанти над постачальниками: «Усі», «Без постачальника», «Не змінювати». */
  leading: ReactNode;
  /** Підказка, коли постачальників немає зовсім (текст залежить від ролі); без неї — без підказки. */
  noneHint?: string;
  enabled: boolean;
  /** `row` — пошук ліворуч від списку (рядок фільтрів), `stack` — над ним (діалог). */
  layout?: 'row' | 'stack';
}

/**
 * Вибір постачальника: перші SUPPLIER_OPTIONS_PAGE за абеткою, а коли їх більше — поле пошуку на
 * сервері (Bug #918, клас Bug #894). Обраний лишається серед варіантів і після нового пошуку, інакше
 * поле показало б порожнє значення. Користувачі: «Позиції» (фільтр і «Постачальник і ціна»), картка
 * підключення до API постачальника.
 */
export function SupplierOptionsSelect({
  value,
  selected,
  extraSelected = null,
  onChange,
  label,
  ariaLabel,
  id,
  required,
  leading,
  noneHint,
  enabled,
  layout = 'stack',
}: SupplierOptionsSelectProps) {
  const { t } = useTranslation('common');
  const hintId = useId();
  const [query, setQuery] = useState('');
  const debounced = useDebounce(query.trim(), 300);
  const { data, isError, isFetching } = useSupplierOptions(debounced, enabled);
  const row = layout === 'row';

  const options = useMemo(() => {
    const list = data?.items ?? [];
    const keep = [selected, extraSelected].find(o => o?.id === value) ?? null;
    return keep && !list.some(s => s.id === keep.id) ? [keep, ...list] : list;
  }, [data, selected, extraSelected, value]);
  const truncated = !!debounced || (data?.total ?? 0) > (data?.items.length ?? 0);
  // Рядок фільтрів: місце пошуку тримається, доки першої відповіді ще немає, — інакше поле
  // з'являлось би після неї й зсувало сусідні фільтри.
  const reserveSearch = row && enabled && !data && !isError;

  // Підказка — лише після відповіді: поки список вантажиться, «немає» було б неправдою.
  const hint = isError
    ? t('supplierSelect.loadFailed')
    : data && !isFetching && data.items.length === 0
      ? debounced
        ? t('supplierSelect.notFound')
        : noneHint
      : undefined;

  const search = truncated && (
    <Input
      {...(id ? { id: `${id}-search` } : {})}
      value={query}
      onChange={e => setQuery(e.target.value)}
      // У діалозі — видимий підпис, як у картці підключення; у рядку фільтрів — лише aria.
      {...(row
        ? { 'aria-label': t('supplierSelect.search') }
        : { label: t('supplierSelect.search') })}
      // У рядку фільтрів поле вузьке — довга підказка обрізалась би.
      placeholder={t(row ? 'supplierSelect.search' : 'supplierSelect.searchPlaceholder', {
        count: SUPPLIER_OPTIONS_PAGE,
      })}
      // Рядок фільтрів списку — висота й шрифт його полів (`h-8 text-[13px]`).
      className={row ? 'h-8 text-[13px]' : undefined}
    />
  );

  const select = (
    <Select
      {...(id ? { id } : {})}
      {...(label ? { label } : {})}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      {...(required ? { required } : {})}
      value={value}
      onChange={e => {
        const picked = e.target.value;
        onChange(picked, options.find(s => s.id === picked) ?? null);
      }}
      // Рядок фільтрів: підказка під вузьким списком зсувала б сусідні фільтри — вона окремо, нижче.
      {...(row ? (hint ? { 'aria-describedby': hintId } : {}) : { hint })}
      className={row ? 'h-8 text-[13px] py-0.5 px-2 pr-7' : undefined}
    >
      {leading}
      {options.map(s => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </Select>
  );

  if (!row) {
    return (
      <div className="space-y-1.5">
        {search}
        {select}
      </div>
    );
  }

  return (
    <div className="relative flex items-start gap-2">
      {(truncated || reserveSearch) && <div className="w-44">{search}</div>}
      <div className="w-52">{select}</div>
      {hint && (
        // Біля пошуку, поверх рядка під ним: висота рядка фільтрів не змінюється.
        <p
          id={hintId}
          role="status"
          className="absolute left-0 top-full z-10 mt-0.5 whitespace-nowrap text-[12px] leading-tight text-muted-foreground"
        >
          {hint}
        </p>
      )}
    </div>
  );
}
