import { WorkOrderStatus } from '@prisma/client';

export const WORK_ORDER_TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  DRAFT:       ['ESTIMATE', 'CANCELLED'],
  ESTIMATE:    ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED:    ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED'],
  ON_HOLD:     ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED:   ['INVOICED'],
  INVOICED:    ['PAID'],
  PAID:        ['ARCHIVED'],
  ARCHIVED:    [],
  CANCELLED:   [],
};

export const CLOSED_STATUSES: WorkOrderStatus[] = ['COMPLETED', 'INVOICED', 'PAID', 'ARCHIVED', 'CANCELLED'];
export const DELETABLE_STATUSES: WorkOrderStatus[] = ['DRAFT', 'CANCELLED'];
export const RESERVATION_ACTIVE_STATUSES: WorkOrderStatus[] = ['IN_PROGRESS', 'ON_HOLD'];
export const EDITABLE_STATUSES: WorkOrderStatus[] = ['DRAFT', 'ESTIMATE', 'APPROVED'];

export const STATUS_LABELS: Record<WorkOrderStatus, string> = {
  DRAFT:       'Чернетка',
  ESTIMATE:    'Кошторис',
  APPROVED:    'Затверджено',
  IN_PROGRESS: 'В роботі',
  ON_HOLD:     'Призупинено',
  COMPLETED:   'Виконано',
  INVOICED:    'Виставлено рахунок',
  PAID:        'Оплачено',
  ARCHIVED:    'Архів',
  CANCELLED:   'Скасовано',
};
