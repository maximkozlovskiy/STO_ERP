'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useDebounce } from '@/hooks/useDebounce';
import { useSupplierOptions, type SupplierOption } from '@/hooks/api/useCounterparties';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

interface SupplierOptionsSelectProps {
  value: string;
  onChange: (id: string) => void;
  /** Видимий підпис (діалог) — або лише `ariaLabel` (фільтр у рядку фільтрів). */
  label?: string;
  ariaLabel?: string;
  /** Службові варіанти над постачальниками: «Усі», «Без постачальника», «Не змінювати». */
  leading: ReactNode;
  /** Підказка, коли постачальників немає зовсім (текст залежить від ролі); без неї — без підказки. */
  noneHint?: string;
  enabled: boolean;
  /** `row` — пошук ліворуч від списку (рядок фільтрів), `stack` — над ним (діалог). */
  layout?: 'row' | 'stack';
}

/**
 * Вибір постачальника в «Позиціях» (фільтр і «Постачальник і ціна»): перші SUPPLIER_OPTIONS_PAGE за
 * абеткою, а коли їх більше — поле пошуку на сервері (Bug #918, клас Bug #894). Обраний лишається
 * серед варіантів і після нового пошуку, інакше поле показало б порожнє значення.
 */
export function SupplierOptionsSelect({
  value,
  onChange,
  label,
  ariaLabel,
  leading,
  noneHint,
  enabled,
  layout = 'stack',
}: SupplierOptionsSelectProps) {
  const { t } = useTranslation('purchaseLists');
  const [query, setQuery] = useState('');
  const debounced = useDebounce(query.trim(), 300);
  const { data, isError, isFetching } = useSupplierOptions(debounced, enabled);
  const [picked, setPicked] = useState<SupplierOption | null>(null);

  const options = useMemo(() => {
    const list = data?.items ?? [];
    return picked && picked.id === value && !list.some(s => s.id === picked.id)
      ? [picked, ...list]
      : list;
  }, [data, picked, value]);
  const truncated = !!debounced || (data?.total ?? 0) > (data?.items.length ?? 0);

  // Підказка — лише після відповіді: поки список вантажиться, «немає» було б неправдою.
  const hint = isError
    ? t('items.dialogs.suppliersLoadFailed')
    : data && !isFetching && data.items.length === 0
      ? debounced
        ? t('items.dialogs.suppliersNotFound')
        : noneHint
      : undefined;

  return (
    <div className={layout === 'row' ? 'flex items-start gap-2' : 'space-y-1.5'}>
      {truncated && (
        <div className={layout === 'row' ? 'w-44' : undefined}>
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            // У діалозі — видимий підпис, як у картці підключення; у рядку фільтрів — лише aria.
            {...(layout === 'row'
              ? { 'aria-label': t('filters.supplierSearch') }
              : { label: t('filters.supplierSearch') })}
            // У рядку фільтрів поле вузьке — довга підказка обрізалась би.
            placeholder={t(
              layout === 'row' ? 'filters.supplierSearch' : 'filters.supplierSearchPlaceholder',
            )}
          />
        </div>
      )}
      <div className={layout === 'row' ? 'w-52' : undefined}>
        <Select
          {...(label ? { label } : {})}
          {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
          value={value}
          onChange={e => {
            const id = e.target.value;
            setPicked(options.find(s => s.id === id) ?? null);
            onChange(id);
          }}
          hint={hint}
        >
          {leading}
          {options.map(s => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}
