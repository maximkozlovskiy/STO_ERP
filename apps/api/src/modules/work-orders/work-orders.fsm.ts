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

export const CLOSED_STATUSES: WorkOrderStatus[] = [
  'COMPLETED',
  'INVOICED',
  'PAID',
  'ARCHIVED',
  'CANCELLED',
];
export const DELETABLE_STATUSES: WorkOrderStatus[] = ['DRAFT', 'CANCELLED'];
export const RESERVATION_ACTIVE_STATUSES: WorkOrderStatus[] = ['IN_PROGRESS', 'ON_HOLD'];
export const EDITABLE_STATUSES: WorkOrderStatus[] = ['DRAFT', 'ESTIMATE', 'APPROVED'];
// Bug #432: backend single-source-of-truth для invoice/completion-act створення з WO.
// Mirror shared `WO_INVOICEABLE_STATUSES` у packages/shared/src/constants/statuses.ts.
// Раніше це було inline literal `['COMPLETED', 'INVOICED']` у 3 місцях
// (invoices.service.ts:150, :589, completion-acts.service.ts:138) — будь-який майбутній
// new status у whitelist не оновить ці 3 файли мовчки.
export const INVOICEABLE_STATUSES: WorkOrderStatus[] = ['COMPLETED', 'INVOICED'];
// Bug #432: same pattern — backend single-source для share/print/SMS gate.
// Mirror shared `WO_SHAREABLE_STATUSES`. Раніше це було приватна static у WorkOrdersService;
// тепер expose-ається для імпорту в інші модулі (якщо знадобиться).
export const SHAREABLE_STATUSES: WorkOrderStatus[] = ['DRAFT', 'ESTIMATE', 'APPROVED'];

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
