'use client';

import { memo, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { fmtQty } from '@/lib/format';
import type { Lift, MonthSlots } from './calendar.types';
import type { CalendarTask } from './calendar-tasks';
import {
  CATEGORY_VIEW,
  SLOT_CATEGORIES,
  SLOT_TYPES,
  SLOT_TYPE_ICON,
  TASK_VIEW,
} from './calendar-categories';
import { buildMonthSummary, TASK_TONES } from './calendar-month-summary';

interface Props {
  yearMonth: string;
  monthSlots: MonthSlots;
  lifts: readonly Lift[];
  tasks: readonly CalendarTask[];
  windowStart: number;
  windowEnd: number;
  nowMs: number;
}

/** Дні місяця `YYYY-MM` — ключі `monthSlots` без довантаженого 1-го числа наступного. */
function daysOfMonth(yearMonth: string): string[] {
  const [y, m] = yearMonth.split('-').map(Number);
  if (!y || !m) return [];
  const n = new Date(y, m, 0).getDate();
  return Array.from({ length: n }, (_, i) => `${yearMonth}-${String(i + 1).padStart(2, '0')}`);
}

const TH = 'px-3 py-2 text-xs font-medium text-muted-foreground';
const TD = 'px-3 py-2';
const NUM = 'text-right tabular-nums';

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bg-surface border border-border rounded-xl overflow-hidden">
      <h3 className="px-4 py-2.5 text-sm font-semibold text-foreground border-b border-border">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Підсумки місяця під сіткою «Місяць» (BR-CAL-013): зведені цифри, підйомники за типами записів,
 * механіки, стан записів і задачі місяця. Лише читання — з уже завантажених даних місяця.
 */
export const CalendarMonthSummary = memo(function CalendarMonthSummary({
  yearMonth,
  monthSlots,
  lifts,
  tasks,
  windowStart,
  windowEnd,
  nowMs,
}: Props) {
  const { t } = useTranslation('calendar');
  const days = useMemo(() => daysOfMonth(yearMonth), [yearMonth]);
  const sum = useMemo(
    () => buildMonthSummary(monthSlots, lifts, tasks, { days, windowStart, windowEnd, nowMs }),
    [monthSlots, lifts, tasks, days, windowStart, windowEnd, nowMs],
  );

  // Підйомники без жодного запису за місяць — один рядок «ще N», а не десятки нулів
  // (середнє завантаження все одно рахує всі пости).
  const shownLifts = sum.lifts.filter(r => r.total > 0);
  const idleLifts = sum.lifts.length - shownLifts.length;

  if (sum.records === 0 && tasks.length === 0)
    return (
      <p className="text-sm text-muted-foreground" data-testid="month-summary-empty">
        {t('month.summary.empty')}
      </p>
    );

  const kpis = [
    { key: 'records', label: t('month.summary.records'), value: String(sum.records) },
    { key: 'hours', label: t('month.summary.busyHours'), value: fmtQty(sum.busyHours) },
    { key: 'workOrders', label: t('month.summary.workOrders'), value: String(sum.workOrders) },
    {
      key: 'load',
      label: t('month.summary.avgLoad'),
      value: sum.avgLoadPct !== null ? `${sum.avgLoadPct}%` : '—',
    },
  ];

  return (
    <div className="space-y-3" data-testid="month-summary">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {kpis.map(k => (
          <div
            key={k.key}
            className="bg-surface border border-border rounded-xl px-3.5 py-2"
            data-testid={`month-summary-${k.key}`}
          >
            <div className="text-xs text-muted-foreground">{k.label}</div>
            <div className="text-xl font-bold text-foreground tabular-nums">{k.value}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title={t('month.summary.liftsTitle')}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="month-summary-lifts">
              <colgroup>
                <col />
                {SLOT_TYPES.map(type => (
                  <col key={type} className="w-14" />
                ))}
                <col className="w-16" />
                <col className="w-16" />
                <col className="w-16" />
              </colgroup>
              <thead>
                <tr className="border-b border-border bg-secondary">
                  <th className={`${TH} text-left`}>{t('month.summary.colLift')}</th>
                  {SLOT_TYPES.map(type => {
                    const Icon = SLOT_TYPE_ICON[type];
                    return (
                      <th key={type} className={`${TH} ${NUM}`} title={t(`month.type.${type}`)}>
                        <Icon className="h-3.5 w-3.5 inline-block" aria-hidden="true" />
                        <span className="sr-only">{t(`month.type.${type}`)}</span>
                      </th>
                    );
                  })}
                  <th className={`${TH} ${NUM}`}>{t('month.summary.colTotal')}</th>
                  <th className={`${TH} ${NUM}`}>{t('month.summary.colHours')}</th>
                  <th className={`${TH} ${NUM}`}>{t('month.summary.colLoad')}</th>
                </tr>
              </thead>
              <tbody>
                {shownLifts.map(r => (
                  <tr key={r.liftId ?? 'none'} className="border-b border-border last:border-b-0">
                    <td className={`${TD} text-foreground`}>
                      {r.liftId ? r.name : t('month.summary.noLift')}
                    </td>
                    {SLOT_TYPES.map(type => (
                      <td key={type} className={`${TD} ${NUM} text-muted-foreground`}>
                        {r.byType[type] || '—'}
                      </td>
                    ))}
                    <td className={`${TD} ${NUM} font-medium text-foreground`}>{r.total}</td>
                    <td className={`${TD} ${NUM} text-foreground`}>{fmtQty(r.hours)}</td>
                    <td className={`${TD} ${NUM} text-foreground`}>
                      {r.loadPct !== null ? `${r.loadPct}%` : '—'}
                    </td>
                  </tr>
                ))}
                {idleLifts > 0 && (
                  <tr data-testid="month-summary-idle-lifts">
                    <td
                      colSpan={SLOT_TYPES.length + 4}
                      className={`${TD} text-xs text-muted-foreground`}
                    >
                      {t('month.summary.idleLifts', { count: idleLifts })}
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-secondary font-medium">
                  <td className={`${TD} text-foreground`}>{t('month.summary.total')}</td>
                  {SLOT_TYPES.map(type => (
                    <td key={type} className={`${TD} ${NUM} text-foreground`}>
                      {sum.liftsTotal.byType[type]}
                    </td>
                  ))}
                  <td className={`${TD} ${NUM} text-foreground`}>{sum.liftsTotal.total}</td>
                  <td className={`${TD} ${NUM} text-foreground`}>{fmtQty(sum.liftsTotal.hours)}</td>
                  <td className={`${TD} ${NUM} text-foreground`}>
                    {sum.liftsTotal.loadPct !== null ? `${sum.liftsTotal.loadPct}%` : '—'}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>

        <Card title={t('month.summary.mechanicsTitle')}>
          {sum.mechanics.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">{t('month.summary.none')}</p>
          ) : (
            <table className="w-full text-sm" data-testid="month-summary-mechanics">
              <colgroup>
                <col />
                <col className="w-20" />
                <col className="w-20" />
                <col className="w-20" />
              </colgroup>
              <thead>
                <tr className="border-b border-border bg-secondary">
                  <th className={`${TH} text-left`}>{t('month.summary.colMechanic')}</th>
                  <th className={`${TH} ${NUM}`}>{t('month.summary.colRecords')}</th>
                  <th className={`${TH} ${NUM}`}>{t('month.summary.colHours')}</th>
                  <th className={`${TH} ${NUM}`}>{t('month.summary.colWorkOrders')}</th>
                </tr>
              </thead>
              <tbody>
                {sum.mechanics.map(m => (
                  <tr
                    key={m.employeeId ?? 'none'}
                    className="border-b border-border last:border-b-0"
                  >
                    <td className={`${TD} text-foreground`}>
                      {m.employeeId ? m.name || '—' : t('month.summary.noMechanic')}
                    </td>
                    <td className={`${TD} ${NUM} text-foreground`}>{m.records}</td>
                    <td className={`${TD} ${NUM} text-foreground`}>{fmtQty(m.hours)}</td>
                    <td className={`${TD} ${NUM} text-foreground`}>{m.workOrders}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title={t('month.summary.categoriesTitle')}>
          <ul className="divide-y divide-border text-sm" data-testid="month-summary-categories">
            {SLOT_CATEGORIES.filter(c => sum.categories[c] > 0).map(c => {
              const view = CATEGORY_VIEW[c];
              const Icon = view.icon;
              return (
                <li key={c} className="flex items-center gap-2 px-4 py-2">
                  <Icon className={`h-4 w-4 shrink-0 ${view.className}`} aria-hidden="true" />
                  <span className="flex-1 text-foreground">{t(`month.category.${c}`)}</span>
                  <span className="tabular-nums font-medium text-foreground">
                    {sum.categories[c]}
                  </span>
                </li>
              );
            })}
            {sum.records === 0 && (
              <li className="px-4 py-2 text-muted-foreground">{t('month.summary.none')}</li>
            )}
          </ul>
        </Card>

        <Card title={t('month.summary.tasksTitle')}>
          <ul className="divide-y divide-border text-sm" data-testid="month-summary-tasks">
            {tasks.length === 0 ? (
              <li className="px-4 py-2 text-muted-foreground">{t('month.summary.none')}</li>
            ) : (
              TASK_TONES.map(tone => (
                <li
                  key={tone}
                  className={`flex items-center gap-2 px-4 py-2 border-l-4 ${TASK_VIEW.barClassName[tone]}`}
                >
                  <span className="flex-1 text-foreground">
                    {t(`month.summary.taskTone.${tone}`)}
                  </span>
                  <span className="tabular-nums font-medium text-foreground">
                    {sum.tasks[tone]}
                  </span>
                </li>
              ))
            )}
          </ul>
        </Card>
      </div>
    </div>
  );
});
