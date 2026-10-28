'use client';

import { memo, useMemo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { taskStatusLabel } from '@/i18n/enumLabel';
import { SIDEBAR_W } from './calendar.utils';
import { TASK_VIEW } from './calendar-categories';
import {
  layoutTaskLanes,
  taskDayBlock,
  taskTimeLabel,
  taskTone,
  type CalendarTask,
} from './calendar-tasks';

/** Найменша видима ширина блоку задачі, год (лише термін — позначка в момент терміну). */
const MIN_TASK_H = 0.5;
/** Висота доріжки смуги, px. */
const LANE_PX = 26;
/** Ширина доріжки в колонці повернутої сітки, px. */
const LANE_W_PX = 96;

interface Props {
  tasks: readonly CalendarTask[];
  date: string;
  windowStart: number;
  windowEnd: number;
  /**
   * Повернута сітка «Дня» (BR-CAL-014): лише колонка з блоками на шкалі годин, доріжки —
   * підколонками; підпис «Задачі» дає шапка сітки.
   */
  vertical?: boolean;
  onOpen: (task: CalendarTask) => void;
}

/**
 * Смуга «Задачі» виду «День» — над рядками підйомників, у тій самій сітці годин (BR-TASK-007:
 * задача — окремий тип, не займає підйомник і час механіка). Блок — проміжок [початок, термін],
 * лише термін — позначка в момент терміну; задачі, що перетинаються, — на різних доріжках.
 * Блоки не перетягуються (поза зоною `DndContext` підйомників); клік відкриває картку задачі.
 */
export const CalendarTaskStrip = memo(function CalendarTaskStrip({
  tasks,
  date,
  windowStart,
  windowEnd,
  vertical = false,
  onOpen,
}: Props) {
  const { t } = useTranslation('calendar');
  const totalHours = Math.max(1, windowEnd - windowStart);

  const blocks = useMemo(
    () =>
      tasks
        .map(task => {
          const b = taskDayBlock(task, date, windowStart, windowEnd);
          if (!b) return null;
          // Позначка на самому закритті зсувається ліворуч, щоб не вийти за сітку.
          const startH = Math.min(b.startH, windowEnd - MIN_TASK_H);
          return { task, startH, endH: Math.max(b.endH, startH + MIN_TASK_H) };
        })
        .filter((b): b is NonNullable<typeof b> => b !== null),
    [tasks, date, windowStart, windowEnd],
  );
  const { lanes, count } = useMemo(
    () =>
      layoutTaskLanes(
        blocks.map(b => ({ id: b.task.id, startH: b.startH, endH: b.endH })),
        MIN_TASK_H,
      ),
    [blocks],
  );

  if (blocks.length === 0) return null;

  if (vertical)
    return (
      <div
        className="relative h-full"
        style={{ width: count * LANE_W_PX + 4 }}
        data-testid="calendar-task-strip"
      >
        {blocks.map(({ task, startH, endH }) => (
          <TaskBlock
            key={task.id}
            task={task}
            onOpen={onOpen}
            style={{
              top: `${((startH - windowStart) / totalHours) * 100}%`,
              height: `${((endH - startH) / totalHours) * 100}%`,
              left: 2 + (lanes.get(task.id) ?? 0) * LANE_W_PX,
              width: LANE_W_PX - 4,
            }}
          />
        ))}
      </div>
    );

  return (
    <div
      className="grid border-b border-border shrink-0"
      style={{ gridTemplateColumns: `${SIDEBAR_W}px 1fr` }}
      data-testid="calendar-task-strip"
    >
      <div
        className="px-3 py-2 bg-secondary border-r border-border flex flex-col justify-center gap-0.5"
        title={t('tasks.stripHint')}
      >
        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <TASK_VIEW.icon className={`h-3.5 w-3.5 ${TASK_VIEW.className}`} aria-hidden="true" />
          {t('tasks.strip')}
        </span>
        <span className="text-[10px] text-muted-foreground leading-tight">
          {t('tasks.stripHint')}
        </span>
      </div>
      <div className="relative py-1" style={{ height: count * LANE_PX + 8 }}>
        {blocks.map(({ task, startH, endH }) => (
          <TaskBlock
            key={task.id}
            task={task}
            onOpen={onOpen}
            style={{
              left: `${((startH - windowStart) / totalHours) * 100}%`,
              width: `${((endH - startH) / totalHours) * 100}%`,
              top: 4 + (lanes.get(task.id) ?? 0) * LANE_PX,
              height: LANE_PX - 4,
            }}
          />
        ))}
      </div>
    </div>
  );
});

/** Блок задачі на шкалі годин — однаковий у смузі планувальника й у колонці повернутої сітки. */
function TaskBlock({
  task,
  onOpen,
  style,
}: {
  task: CalendarTask;
  onOpen: (task: CalendarTask) => void;
  style: CSSProperties;
}) {
  const { t } = useTranslation('calendar');
  const tone = taskTone(task);
  const time = taskTimeLabel(task);
  const status = taskStatusLabel(task.status);
  return (
    <button
      type="button"
      onClick={() => onOpen(task)}
      title={[time, task.title, task.assigneeName, status].filter(Boolean).join('\n')}
      aria-label={`${time} ${t('tasks.blockAria', {
        title: task.title,
        assignee: task.assigneeName,
        status,
      })}`}
      data-testid="calendar-task-block"
      data-task-id={task.id}
      data-tone={tone}
      className={`absolute flex items-center gap-1 overflow-hidden rounded border border-border border-l-4 ${TASK_VIEW.barClassName[tone]} ${TASK_VIEW.bgClassName} px-1.5 text-left text-[11px] leading-tight text-foreground hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${tone === 'cancelled' ? 'line-through opacity-70' : ''}`}
      style={style}
    >
      <TASK_VIEW.icon className={`h-3 w-3 shrink-0 ${TASK_VIEW.className}`} aria-hidden="true" />
      <span className="min-w-0 truncate font-medium">{task.title}</span>
      <span className="min-w-0 truncate text-muted-foreground">· {task.assigneeName}</span>
    </button>
  );
}
