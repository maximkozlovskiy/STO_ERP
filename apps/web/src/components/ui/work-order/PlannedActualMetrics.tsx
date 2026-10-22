'use client';

// Панель «Планові та фактичні показники» наряду (TD3-декомпозиція CreateWorkOrderModal).
// Винесено без зміни поведінки — cohesive суб-форма (дати/нормогодини). Фактична колонка
// read-only (заповнюється з ліній): дати завжди disabled+NOOP, нормогодини = liveActualHours
// (обчислені з ліній) або form.actualHours, disabled коли live-значення присутнє.
import { memo, useId, useMemo, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { DateTimePickerInput } from '@/components/ui/datetime-picker-input';
import { localDateTimeToISO } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useNow } from '@/hooks/useNow';
import type { WorkHoursWindow } from './planned-dates';

const NOOP_DT_CHANGE: (v: string) => void = () => {};

/**
 * Початок · завершення · нормогодини; дата з часом «ДД.ММ.РРРР ГГ:ХХ» не обрізається (Bug #878).
 * `items-end`: підпис, що переноситься у вузькій колонці («Дата та час завершення»), не зсуває
 * поле нижче за сусідні — поля стоять в одну лінію, і з ними підйомник картки (Bug #937).
 */
const METRICS_GRID = 'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5.5rem] items-end gap-2.5';
const HOURS_LABEL = 'block text-[13px] font-medium text-foreground';
/**
 * «План» / «Факт» — мітка в рядку підписів, а не окремий рядок над ними: секція «Планування» не
 * тратить висоту на легенду. Легенда fieldset-а лишається для читачів екрана (`sr-only`).
 */
const GROUP_TAG = 'mr-1.5 inline-block rounded px-1.5 py-px text-[11px] font-semibold uppercase';
const HOURS_INPUT =
  'h-9 w-full rounded border border-input bg-surface px-3 text-[14px] text-right tabular-nums ' +
  'hover:border-input-hover focus:outline-none focus:border-primary focus:ring-3 focus:ring-brand-100 ' +
  'disabled:opacity-60 disabled:cursor-not-allowed disabled:bg-secondary';

export interface PlannedActualMetricsProps {
  canEdit: boolean;
  plannedStartAt: string;
  plannedEndAt: string;
  plannedHours: string;
  actualHours: string;
  liveActualHours: number | null;
  onPlannedStartChange: (v: string) => void;
  onPlannedEndChange: (v: string) => void;
  onPlannedHoursChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onActualHoursChange: (e: ChangeEvent<HTMLInputElement>) => void;
  /** Робочі години філії наряду (BR-WO-019): поза ними планові час недоступний. */
  workHours: WorkHoursWindow;
}

// sto-optimize (2.17): усі пропси — примітиви (canEdit/*Hours/liveActualHours) або
// useCallback-стабільні хендлери (див. CreateWorkOrderModal:838-870). Батько (CreateWorkOrderModal)
// ре-рендериться на КОЖЕН символ у будь-якому полі великої форми → без memo ця суб-форма
// (2× DateTimePickerInput + 2× number input) реконсилюється дарма щоразу. memo = runtime-барʼєр.
function PlannedActualMetricsBase({
  canEdit,
  plannedStartAt,
  plannedEndAt,
  plannedHours,
  actualHours,
  liveActualHours,
  onPlannedStartChange,
  onPlannedEndChange,
  onPlannedHoursChange,
  onActualHoursChange,
  workHours,
}: PlannedActualMetricsProps) {
  // «Зараз» (оновлюється щохвилини): минулі дні й години недоступні (BR-WO-019). Таймер тут, а
  // не в картці наряду: щохвилинне оновлення ре-рендерить лише цю панель.
  const { t } = useTranslation('workOrders');
  const plannedHoursId = useId();
  const actualHoursId = useId();
  const now = useNow(60_000);
  // Завершення — пізніше за початок: найраніше — хвилина після початку, якщо він у майбутньому.
  const endMin = useMemo(() => {
    const iso = plannedStartAt ? localDateTimeToISO(plannedStartAt) : null;
    const start = iso ? new Date(iso).getTime() + 60_000 : NaN;
    return Number.isFinite(start) && start > now.getTime() ? new Date(start) : now;
  }, [plannedStartAt, now]);
  // Факт ще не ведеться (немає ні введених, ні обчислених з рядків годин) — поля пунктирні.
  const actualTracked = liveActualHours != null || actualHours !== '';
  const actualFieldClass = actualTracked ? '' : 'border-dashed bg-secondary';
  return (
    // Два fieldset-и — окремі елементи сітки секції «Планування» (поруч або один під одним).
    // План стоїть першим у DOM: на порядок полів спираються тести (Нормогодин [0] — план).
    <>
      <fieldset className="m-0 min-w-0 border-0 p-0" data-testid="wo-planned">
        <legend className="sr-only">{t('card.plan')}</legend>
        <div className={METRICS_GRID}>
          <DateTimePickerInput
            label={t('card.startAt')}
            labelAddon={
              <span aria-hidden="true" className={cn(GROUP_TAG, 'bg-primary/10 text-primary')}>
                {t('card.plan')}
              </span>
            }
            value={plannedStartAt}
            onChange={onPlannedStartChange}
            disabled={!canEdit}
            minDateTime={now}
            minHour={workHours.startHour}
            maxHour={workHours.endHour - 1}
            clearable
          />
          <DateTimePickerInput
            label={t('card.endAt')}
            value={plannedEndAt}
            onChange={onPlannedEndChange}
            disabled={!canEdit}
            minDateTime={endMin}
            minHour={workHours.startHour}
            closeHour={workHours.endHour}
            clearable
          />
          <div className="flex flex-col gap-1">
            <label htmlFor={plannedHoursId} className={HOURS_LABEL}>
              {t('card.normoHours')}
            </label>
            <input
              id={plannedHoursId}
              type="number"
              min="0"
              step="0.5"
              value={plannedHours}
              onChange={onPlannedHoursChange}
              disabled={!canEdit}
              placeholder="0"
              className={HOURS_INPUT}
            />
          </div>
        </div>
      </fieldset>
      {/* У сітці «Планування»: вужче 2xl — під «Планом» (колонка 2), ширше — третя колонка. */}
      <fieldset
        className="m-0 min-w-0 border-0 p-0 md:col-start-2 2xl:col-start-3"
        data-testid="wo-actual"
      >
        <legend className="sr-only">
          {t('card.actual')} — {t('card.actualHint')}
        </legend>
        <div className={METRICS_GRID}>
          <DateTimePickerInput
            label={t('card.startAt')}
            labelAddon={
              <span
                aria-hidden="true"
                title={t('card.actualHint')}
                className={cn(GROUP_TAG, 'bg-secondary text-foreground-muted')}
              >
                {t('card.actual')}
              </span>
            }
            value=""
            onChange={NOOP_DT_CHANGE}
            disabled
            inputClassName={actualFieldClass}
          />
          <DateTimePickerInput
            label={t('card.endAt')}
            value=""
            onChange={NOOP_DT_CHANGE}
            disabled
            inputClassName={actualFieldClass}
          />
          <div className="flex flex-col gap-1">
            <label htmlFor={actualHoursId} className={HOURS_LABEL}>
              {t('card.normoHours')}
            </label>
            <input
              id={actualHoursId}
              type="number"
              min="0"
              step="0.5"
              value={liveActualHours != null ? liveActualHours : actualHours}
              onChange={onActualHoursChange}
              disabled={!canEdit || liveActualHours != null}
              placeholder="0"
              className={cn(HOURS_INPUT, actualFieldClass)}
            />
          </div>
        </div>
      </fieldset>
    </>
  );
}

export const PlannedActualMetrics = memo(PlannedActualMetricsBase);
