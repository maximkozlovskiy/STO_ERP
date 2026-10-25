import { z } from 'zod';
import { optionalString } from '../validators';

/**
 * Спільна zod-схема форми задачі (Task, BR-TASK-*) — ЄДИНЕ джерело правди валідації для web і api.
 *
 * `startAt` / `dueAt` — мітки часу ISO (з вибору дати й часу); порожні — undefined. Обидва задані →
 * початок не пізніше терміну (BR-TASK-004).
 */
export const TASK_TITLE_MAX = 200;
export const TASK_DESCRIPTION_MAX = 2000;

const optionalUuid = () =>
  z
    .string()
    .trim()
    .optional()
    .transform(v => (v ? v : undefined))
    .pipe(z.string().uuid('v.uuid').optional());

const optionalInstant = () =>
  z
    .string()
    .trim()
    .optional()
    .transform(v => (v ? v : undefined))
    .refine(v => v === undefined || !Number.isNaN(Date.parse(v)), 'v.task.dateTime.invalid');

export const taskFormSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, 'v.task.title.required')
      .max(TASK_TITLE_MAX, 'v.task.title.max'),
    description: optionalString().pipe(
      z.string().max(TASK_DESCRIPTION_MAX, 'v.task.description.max').optional(),
    ),
    assigneeId: z.string().trim().min(1, 'v.task.assignee.required').uuid('v.uuid'),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
    startAt: optionalInstant(),
    dueAt: optionalInstant(),
    workOrderId: optionalUuid(),
    vehicleId: optionalUuid(),
    counterpartyId: optionalUuid(),
  })
  .refine(v => !v.startAt || !v.dueAt || Date.parse(v.startAt) <= Date.parse(v.dueAt), {
    message: 'v.task.dueBeforeStart',
    path: ['dueAt'],
  });

/** Значення форми ПІСЛЯ парсингу (порожні опційні — undefined). */
export type TaskFormValues = z.infer<typeof taskFormSchema>;

/** Вхідні значення форми (web-стан) — до коерції. */
export type TaskFormInput = z.input<typeof taskFormSchema>;
