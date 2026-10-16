'use client';

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatPersonName } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { Select } from '@/components/ui/select';
import type { SavedMechanic } from './calendar.types';

interface MechanicOption {
  id: string;
  firstName: string;
  lastName: string;
}

interface CalendarMechanicFieldProps {
  liftId: string;
  value: string;
  onChange: (employeeId: string) => void;
  /** Значення запису, що редагується; `null` — новий запис. */
  saved: SavedMechanic | null;
  /** Минулий запис або користувач без права змінювати (механік): лише показ, без запитів. */
  disabled: boolean;
}

type Loaded = { liftId: string; items: MechanicOption[] } | { liftId: string; error: true };

/**
 * Поле «Механік» форми запису календаря (BR-CAL-012): лише активні механіки, закріплені за
 * підйомником запису (`GET /employees?liftId=`). Без підйомника поле недоступне; зміна підйомника
 * скидає механіка, не закріпленого за новим. Збережений механік, якого вже не можна обрати
 * (звільнений чи відкріплений), лишається недоступною опцією з поясненням, доки його не змінять, —
 * як рахунок «Готівки» в НДІ (BR-PAY-019).
 */
export function CalendarMechanicField({
  liftId,
  value,
  onChange,
  saved,
  disabled,
}: CalendarMechanicFieldProps) {
  const { t } = useTranslation('calendar');
  const id = useId();
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (disabled || !liftId) return;
    const ac = new AbortController();
    apiFetch<{ items: MechanicOption[] }>(
      `/employees?liftId=${encodeURIComponent(liftId)}&role=MECHANIC&limit=200`,
      { signal: ac.signal },
    ).then(
      res => {
        if (!ac.signal.aborted) setLoaded({ liftId, items: res.items });
      },
      () => {
        if (!ac.signal.aborted) setLoaded({ liftId, error: true });
      },
    );
    return () => ac.abort();
  }, [liftId, disabled]);

  // Відповідь для іншого підйомника (щойно змінили) — ще не список цього.
  const current = loaded?.liftId === liftId ? loaded : null;
  const items = current && 'items' in current ? current.items : null;
  const failed = !!current && 'error' in current;
  const isSavedPair = !!saved && value === saved.employeeId && liftId === saved.liftId;
  const inList = !!items?.some(m => m.id === value);

  // Зміна підйомника скидає механіка, не закріпленого за новим. Збережену пару «механік +
  // підйомник» не чіпаємо: її показує недоступна опція. Доки список не прийшов чи не завантажився,
  // нічого не скидаємо — інакше збій мережі мовчки знімав би механіка.
  const shouldReset = !disabled && !!value && !isSavedPair && (!liftId || (!!items && !inList));
  useEffect(() => {
    if (shouldReset) onChange('');
  }, [shouldReset, onChange]);

  const savedName = saved?.employeeName ?? t('slot.mechanicUnknown');
  const unavailable =
    !!value && isSavedPair && (disabled ? false : !liftId || (!!items && !inList));

  let hint: string | undefined;
  let errorMessage: string | undefined;
  if (!disabled) {
    if (unavailable) errorMessage = t('slot.mechanicUnavailableHint');
    else if (!liftId) hint = t('slot.mechanicNeedLift');
    else if (failed) errorMessage = t('slot.mechanicLoadError');
    else if (!items) hint = t('slot.mechanicLoading');
    else if (items.length === 0) hint = t('slot.mechanicNoneOnLift');
  }

  return (
    <div>
      <label htmlFor={id} className="block text-[13px] font-medium text-muted-foreground mb-1">
        {t('slot.fieldMechanic')}
      </label>
      <Select
        id={id}
        value={value}
        disabled={disabled || !liftId}
        aria-busy={!disabled && !!liftId && !current}
        onChange={e => onChange(e.target.value)}
        hint={hint}
        errorMessage={errorMessage}
        className="h-8 text-[13px] py-0.5 px-2 pr-7"
      >
        <option value="">{t('slot.mechanicNone')}</option>
        {/* Лише показ (минулий запис, механік): списку немає — назва збереженого механіка */}
        {disabled && value && (
          <option value={value}>
            {saved?.employeeName ??
              t('slot.mechanicUnavailable', { name: t('slot.mechanicUnknown') })}
          </option>
        )}
        {!disabled && unavailable && (
          <option value={value} disabled>
            {t('slot.mechanicUnavailable', { name: savedName })}
          </option>
        )}
        {/* Доки список підйомника вантажиться, обраний механік лишається видимим */}
        {!disabled && value && !items && !unavailable && liftId && (
          <option value={value}>{isSavedPair ? savedName : t('slot.mechanicLoading')}</option>
        )}
        {!disabled &&
          items?.map(m => (
            <option key={m.id} value={m.id}>
              {formatPersonName(m.lastName, m.firstName)}
            </option>
          ))}
      </Select>
    </div>
  );
}
