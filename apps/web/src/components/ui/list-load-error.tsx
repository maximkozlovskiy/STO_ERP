'use client';

import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Button } from './button';

interface ListLoadErrorProps {
  /** Помилка запиту списку (`error` з useQuery); `null` / `undefined` — нічого не рендериться. */
  error: unknown;
  /** Повторити запит (`refetch` з useQuery). */
  onRetry?: () => void;
  className?: string;
}

/**
 * Смуга «список не завантажився» над таблицею.
 *
 * Без неї збій запиту виглядав як порожній список: таблиця показувала «нічого не знайдено»
 * (або попередні рядки під зміненим відбором), і користувач не мав як дізнатись, що це помилка,
 * а не відсутність документів. Порожній стан на екрані має ховатись, поки є помилка без даних.
 */
export function ListLoadError({ error, onRetry, className }: ListLoadErrorProps) {
  const { t } = useTranslation('common');
  if (!error) return null;
  const message = error instanceof Error && error.message ? error.message : t('listLoadError');
  return (
    <div
      role="alert"
      className={cn(
        'flex items-center justify-between gap-3 text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2',
        className,
      )}
    >
      <span>{message}</span>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0">
          {t('retry')}
        </Button>
      )}
    </div>
  );
}
