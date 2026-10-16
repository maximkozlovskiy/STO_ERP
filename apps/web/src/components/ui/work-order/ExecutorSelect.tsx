'use client';

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { formatPersonName } from '@sto/shared';
import { Select } from '@/components/ui/select';

interface ExecutorOption {
  id: string;
  firstName: string;
  lastName: string;
}

export interface SavedExecutor {
  employeeId: string;
  /** Ім'я з відповіді наряду (`employeeName` рядка) — є і для того, кого немає в довіднику. */
  employeeName?: string;
}

interface ExecutorSelectProps {
  value: string;
  onChange: (employeeId: string) => void;
  /** Активні механіки (`activeMechanics`) — єдині, кого можна обрати заново. */
  employees: readonly ExecutorOption[];
  /** Збережений виконавець рядка; `null`/відсутній — новий рядок. */
  saved?: SavedExecutor | null;
  placeholder: string;
  disabled?: boolean;
  ariaLabel?: string;
}

/**
 * «Виконавець» рядка роботи наряду (BR-WO-018). Пропонує лише активних механіків; збережений
 * виконавець, якого в цьому списку немає (не механік — власник чи адмін — звільнений або у
 * відпустці), показується своїм ім'ям як недоступна опція з поясненням, а не «— Механік —», і
 * лишається, доки його не змінять. Той самий патерн, що поле «Механік» календаря
 * (`CalendarMechanicField`, BR-CAL-012) і рахунок «Готівки» в НДІ.
 */
export function ExecutorSelect({
  value,
  onChange,
  employees,
  saved,
  placeholder,
  disabled,
  ariaLabel,
}: ExecutorSelectProps) {
  const { t } = useTranslation('workOrders');
  const id = useId();
  const unavailable =
    !!value && !!saved && value === saved.employeeId && !employees.some(e => e.id === value);
  const savedName = saved?.employeeName || t('lines.executorUnknown');

  return (
    <Select
      id={id}
      value={value}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      aria-label={ariaLabel}
      title={unavailable ? t('lines.executorUnavailableHint') : undefined}
      errorMessage={unavailable && !disabled ? t('lines.executorUnavailableHint') : undefined}
    >
      <option value="">{placeholder}</option>
      {unavailable && (
        <option value={value} disabled>
          {t('lines.executorUnavailable', { name: savedName })}
        </option>
      )}
      {employees.map(e => (
        <option key={e.id} value={e.id}>
          {formatPersonName(e.lastName, e.firstName)}
        </option>
      ))}
    </Select>
  );
}
