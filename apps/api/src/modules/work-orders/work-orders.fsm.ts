import { WorkOrderStatus } from '@prisma/client';

export const WORK_ORDER_TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  DRAFT: ['ESTIMATE', 'CANCELLED'],
  ESTIMATE: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED'],
  ON_HOLD: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['INVOICED'],
  INVOICED: ['PAID'],
  PAID: ['ARCHIVED'],
  ARCHIVED: [],
  CANCELLED: [],
};

export const CLOSED_STATUSES: readonly WorkOrderStatus[] = Object.freeze([
  'COMPLETED',
  'INVOICED',
  'PAID',
  'ARCHIVED',
  'CANCELLED',
]);
export const DELETABLE_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['DRAFT', 'CANCELLED']);
export const RESERVATION_ACTIVE_STATUSES: readonly WorkOrderStatus[] = Object.freeze([
  'IN_PROGRESS',
  'ON_HOLD',
]);
export const EDITABLE_STATUSES: readonly WorkOrderStatus[] = Object.freeze([
  'DRAFT',
  'ESTIMATE',
  'APPROVED',
]);
// Bug #522: для line-level операцій що зачіпають ТІЛЬКИ фактичні години (actualHours)
// дозволяємо ще IN_PROGRESS/ON_HOLD — це сенс FSM "В роботі": механік закриває рядок
// з фактичним часом виконання. Інші лінійні поля (workId/employeeId/normoHours/price)
// заборонені поза EDITABLE_STATUSES, бо вони змінюють кошторис після затвердження.
// Frontend canEditActual = (IN_PROGRESS || ON_HOLD) → нова Save button у тих статусах.
export const LINE_ACTUAL_EDITABLE_STATUSES: readonly WorkOrderStatus[] = Object.freeze([
  ...EDITABLE_STATUSES,
  'IN_PROGRESS',
  'ON_HOLD',
]);
// Single source for invoice/completion-act gate. Mirrors WO_INVOICEABLE_STATUSES in @sto/shared.
export const INVOICEABLE_STATUSES: readonly WorkOrderStatus[] = Object.freeze([
  'COMPLETED',
  'INVOICED',
]);
// Single source for share/print/SMS gate. Mirrors WO_SHAREABLE_STATUSES in @sto/shared.
export const SHAREABLE_STATUSES: readonly WorkOrderStatus[] = Object.freeze([
  'DRAFT',
  'ESTIMATE',
  'APPROVED',
]);

export const STATUS_LABELS: Record<WorkOrderStatus, string> = {
  DRAFT: 'Чернетка',
  ESTIMATE: 'Кошторис',
  APPROVED: 'Затверджено',
  IN_PROGRESS: 'В роботі',
  ON_HOLD: 'Призупинено',
  COMPLETED: 'Виконано',
  INVOICED: 'Виставлено рахунок',
  PAID: 'Оплачено',
  ARCHIVED: 'Архів',
  CANCELLED: 'Скасовано',
};
