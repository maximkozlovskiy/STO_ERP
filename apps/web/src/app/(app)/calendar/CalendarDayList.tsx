'use client';

import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@/components/ui/spinner';
import type { CalendarSlot, Lift } from './calendar.types';
import { CATEGORY_VIEW, SLOT_TYPE_ICON, TASK_VIEW, slotType } from './calendar-categories';
import { daySlotCategory } from './calendar-day';
import { taskTimeLabel, taskTone, type CalendarTask } from './calendar-tasks';
import { fmtTime } from './calendar.utils';

interface Props {
  slots: readonly CalendarSlot[];
  lifts: readonly Lift[];
  tasks: readonly CalendarTask[];
  loading: boolean;
  chainEnds: ReadonlyMap<string, number>;
  nowMs: number;
  onOpenSlot: (slot: CalendarSlot) => void;
  onOpenTask: (task: CalendarTask) => void;
}

const TH = 'px-3 py-2 text-xs font-medium text-muted-foreground text-left';
const TD = 'px-3 py-2 align-top';

/**
 * Вид «День», режим «Список» (BR-CAL-014): задачі дня окремим блоком, нижче — записи дня таблицею
 * за часом початку, разом із записами без підйомника. Клік по рядку чи кнопка часу (клавіатура)
 * відкриває форму запису — та сама, що з планувальника; без прав — лише перегляд (BR-CAL-010).
 */
export const CalendarDayList = memo(function CalendarDayList({
  slots,
  lifts,
  tasks,
  loading,
  chainEnds,
  nowMs,
  onOpenSlot,
  onOpenTask,
}: Props) {
  const { t } = useTranslation('calendar');
  const liftName = useMemo(() => new Map(lifts.map(l => [l.id, l.name])), [lifts]);
  const sorted = useMemo(
    () =>
      [...slots].sort(
        (a, b) =>
          new Date(a.startAt).getTime() - new Date(b.startAt).getTime() ||
          (liftName.get(a.liftId ?? '') ?? '').localeCompare(
            liftName.get(b.liftId ?? '') ?? '',
            'uk',
          ),
      ),
    [slots, liftName],
  );

  if (loading)
    return (
      <div className="flex justify-center py-8">
        <Spinner size="md" />
      </div>
    );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-4" data-testid="day-list">
      {tasks.length > 0 && (
        <section className="bg-surface border border-border rounded-xl overflow-hidden">
          <h3 className="px-4 py-2.5 text-sm font-semibold text-foreground border-b border-border">
            {t('day.list.tasksTitle')}
          </h3>
          <ul className="divide-y divide-border" data-testid="day-list-tasks">
            {tasks.map(task => (
              <li key={task.id} className={`border-l-4 ${TASK_VIEW.barClassName[taskTone(task)]}`}>
                <button
                  type="button"
                  onClick={() => onOpenTask(task)}
                  className="w-full flex items-center gap-3 px-4 py-2 text-left text-sm hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="w-28 shrink-0 tabular-nums text-muted-foreground">
                    {taskTimeLabel(task)}
                  </span>
                  <span className="flex-1 truncate text-foreground">{task.title}</span>
                  {task.assigneeName && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {task.assigneeName}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="bg-surface border border-border rounded-xl overflow-hidden">
        {sorted.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            {t('day.list.empty')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="day-list-slots">
              <colgroup>
                <col className="w-28" />
                <col className="w-36" />
                <col className="w-32" />
                <col />
                <col />
                <col className="w-40" />
                <col className="w-40" />
                <col />
              </colgroup>
              <thead>
                <tr className="border-b border-border bg-secondary">
                  <th className={TH}>{t('day.list.colTime')}</th>
                  <th className={TH}>{t('day.list.colLift')}</th>
                  <th className={TH}>{t('day.list.colType')}</th>
                  <th className={TH}>{t('day.list.colClient')}</th>
                  <th className={TH}>{t('day.list.colVehicle')}</th>
                  <th className={TH}>{t('day.list.colWorkOrder')}</th>
                  <th className={TH}>{t('day.list.colMechanic')}</th>
                  <th className={TH}>{t('day.list.colNotes')}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(s => {
                  const category = daySlotCategory(s, chainEnds, nowMs);
                  const view = CATEGORY_VIEW[category];
                  const type = slotType(s.type);
                  const TypeIcon = SLOT_TYPE_ICON[type];
                  const time = `${fmtTime(s.startAt)}–${fmtTime(s.endAt)}`;
                  return (
                    <tr
                      key={s.id}
                      data-slot-id={s.id}
                      data-category={category}
                      onClick={() => onOpenSlot(s)}
                      className="border-b border-border last:border-b-0 cursor-pointer hover:bg-secondary/50"
                    >
                      <td className={`${TD} border-l-4 ${view.barClassName}`}>
                        {/* Кнопка — для клавіатури: рядок таблиці кнопкою бути не може */}
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            onOpenSlot(s);
                          }}
                          className="whitespace-nowrap tabular-nums font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                          aria-label={t('day.list.openAria', { time })}
                        >
                          {time}
                        </button>
                      </td>
                      <td className={`${TD} text-foreground`}>
                        {s.liftId ? (liftName.get(s.liftId) ?? '—') : t('day.list.noLift')}
                      </td>
                      <td className={`${TD} text-foreground`}>
                        <span className="inline-flex items-center gap-1.5">
                          <TypeIcon
                            className="h-3.5 w-3.5 text-muted-foreground"
                            aria-hidden="true"
                          />
                          {t(`month.type.${type}`)}
                        </span>
                      </td>
                      <td className={TD}>
                        <div className="text-foreground">{s.counterpartyName || '—'}</div>
                        {s.cpPhone && (
                          <div className="text-xs text-muted-foreground tabular-nums">
                            {s.cpPhone}
                          </div>
                        )}
                      </td>
                      <td className={TD}>
                        <div className="text-foreground">{s.vehicleSummary || '—'}</div>
                        {s.vehiclePlate && (
                          <div className="text-xs text-muted-foreground">{s.vehiclePlate}</div>
                        )}
                      </td>
                      <td className={TD}>
                        {s.workOrderNumber ? (
                          <>
                            <div className="text-foreground">{s.workOrderNumber}</div>
                            <div className={`text-xs ${view.className}`}>
                              {t(`month.category.${category}`)}
                            </div>
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className={`${TD} text-foreground`}>
                        {s.employeeName || <span className="text-muted-foreground">—</span>}
                      </td>
                      {/* wrap-anywhere: «слово» без пробілів не розтягує таблицю (Bug #989, #855) */}
                      <td className={`${TD} text-muted-foreground wrap-anywhere`}>
                        {s.notes || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
});
