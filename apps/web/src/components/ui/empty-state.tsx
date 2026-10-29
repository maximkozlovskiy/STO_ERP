'use client';

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { type LucideIcon, Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface EmptyStateProps {
  icon?: LucideIcon;
  title?: string;
  description?: string;
  action?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizes = {
  sm: {
    wrap: 'py-8',
    icon: 'h-10 w-10',
    iconInner: 'h-5 w-5',
    title: 'text-[13px]',
    desc: 'text-[12px]',
  },
  md: {
    wrap: 'py-14',
    icon: 'h-14 w-14',
    iconInner: 'h-6 w-6',
    title: 'text-[14px]',
    desc: 'text-[13px]',
  },
  lg: {
    wrap: 'py-20',
    icon: 'h-16 w-16',
    iconInner: 'h-7 w-7',
    title: 'text-[15px]',
    desc: 'text-[13px]',
  },
};

function EmptyState({
  icon: Icon = Inbox,
  title: titleProp,
  description,
  action,
  size = 'md',
  className,
}: EmptyStateProps) {
  const { t } = useTranslation('common');
  const title = titleProp ?? t('nothingFound');
  const s = sizes[size];
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 text-center',
        s.wrap,
        className,
      )}
    >
      <div
        className={cn(
          'flex items-center justify-center rounded-full',
          'bg-secondary border border-border',
          s.icon,
        )}
      >
        <Icon className={cn(s.iconInner, 'text-muted-foreground')} />
      </div>
      <div className="flex flex-col gap-1 max-w-xs">
        <p className={cn('font-semibold text-foreground', s.title)}>{title}</p>
        {description && (
          <p className={cn('text-muted-foreground leading-snug', s.desc)}>{description}</p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

interface ListEmptyStateProps extends Omit<EmptyStateProps, 'action'> {
  /** Чи стоїть хоч один фільтр (зокрема період дат) — тоді порожньо «за фільтрами». */
  filtered: boolean;
  /** Зняти всі фільтри списку, зокрема дати. Немає — без кнопки. */
  onResetFilters?: () => void;
  /** Дія порожнього списку без фільтрів (наприклад, «Створити»). */
  action?: ReactNode;
}

/**
 * Порожній список (UX-огляд 2026-10-29): з фільтрами — «За фільтрами нічого не знайдено» і кнопка
 * «Скинути фільтри» (типовий фільтр «сьогодні» лишається, тож порожньо буває часто); без фільтрів —
 * власний заголовок і підказка списку («Створіть перший…»).
 */
function ListEmptyState({
  filtered,
  onResetFilters,
  title,
  description,
  action,
  ...rest
}: ListEmptyStateProps) {
  const { t } = useTranslation('common');
  if (!filtered)
    return <EmptyState {...rest} title={title} description={description} action={action} />;
  return (
    <EmptyState
      {...rest}
      title={t('emptyFiltered.title')}
      description={t('emptyFiltered.desc')}
      action={
        onResetFilters ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onResetFilters}
            data-testid="empty-reset-filters"
          >
            {t('emptyFiltered.reset')}
          </Button>
        ) : undefined
      }
    />
  );
}

export { EmptyState, ListEmptyState };
export type { EmptyStateProps };
