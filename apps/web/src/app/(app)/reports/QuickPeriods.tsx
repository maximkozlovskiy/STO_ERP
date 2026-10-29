'use client';

import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { kyivToday } from '@/lib/format';
import { QUICK_PERIODS, activeQuickPeriod, quickPeriodRange } from './report-periods';

/**
 * Кнопки швидкого періоду біля «З / По» на вкладках звітів із датами. Межі — київські
 * (`kyivToday`); кнопка періоду, що збігається з обраними датами, підсвічена (`aria-pressed`).
 */
export function QuickPeriods({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
}) {
  const { t } = useTranslation('reports');
  const today = kyivToday();
  const active = activeQuickPeriod(from, to, today);
  return (
    <div
      role="group"
      aria-label={t('page.periods.label')}
      className="inline-flex rounded-lg border border-border bg-surface p-0.5"
      data-testid="report-quick-periods"
    >
      {QUICK_PERIODS.map(kind => (
        <button
          key={kind}
          type="button"
          aria-pressed={active === kind}
          onClick={() => onChange(quickPeriodRange(kind, today))}
          className={cn(
            'h-7 px-3 rounded-md text-[13px] font-medium whitespace-nowrap transition-colors',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
            active === kind
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          {t(`page.periods.${kind}`)}
        </button>
      ))}
    </div>
  );
}
