import type { WorkOrderStatus } from '@prisma/client';
import {
  WO_EDITABLE_STATUSES,
  WO_SHAREABLE_STATUSES,
  WO_INVOICEABLE_STATUSES,
  WO_PROCUREMENT_ACTIVE_STATUSES,
  WO_CLOSED_STATUSES,
  WO_STATUS_TRANSITIONS,
} from '@sto/shared';

// A5: gate-множини мають ЄДИНЕ джерело у @sto/shared (browser-safe string[]) — backend і frontend
// читають ті самі значення. Тут лише звужуємо тип до WorkOrderStatus[] (значення ідентичні) —
// жодного ручного дзеркалення коментарем «Must mirror». Backend-специфічні множини (DELETABLE/
// RESERVATION_ACTIVE/LINE_ACTUAL) лишаються локальними — вони не потрібні фронту.
const asWoStatuses = (arr: readonly string[]): readonly WorkOrderStatus[] =>
  Object.freeze(arr as readonly WorkOrderStatus[]);

// Карта переходів — теж ЄДИНЕ джерело у @sto/shared (WO_STATUS_TRANSITIONS): UI показує рівно ті
// кнопки, які сервер прийме. Що ключі й цілі — це рівно значення Prisma-enum WorkOrderStatus,
// стереже fsm-parity.spec.ts. Пояснення правил (C2 / BR-WO-031, BR-WO-014) — біля карти в shared.
export const WORK_ORDER_TRANSITIONS = WO_STATUS_TRANSITIONS as unknown as Readonly<
  Record<WorkOrderStatus, readonly WorkOrderStatus[]>
>;

// Єдине джерело — WO_CLOSED_STATUSES у @sto/shared (inline-зміна пріоритету в списку його читає).
export const CLOSED_STATUSES: readonly WorkOrderStatus[] = asWoStatuses(WO_CLOSED_STATUSES);
export const DELETABLE_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['DRAFT', 'CANCELLED']);
export const RESERVATION_ACTIVE_STATUSES: readonly WorkOrderStatus[] = Object.freeze([
  'IN_PROGRESS',
  'ON_HOLD',
]);
// A5: єдине джерело — WO_EDITABLE_STATUSES у @sto/shared.
export const EDITABLE_STATUSES: readonly WorkOrderStatus[] = asWoStatuses(WO_EDITABLE_STATUSES);
// For line-level patches that touch ONLY actualHours, also allow IN_PROGRESS/ON_HOLD —
// a mechanic closing a work line with actual time. Other line fields (workId/employeeId/normoHours/price)
// are forbidden outside EDITABLE_STATUSES because they alter the approved estimate.
// Frontend: canEditActual = (IN_PROGRESS || ON_HOLD) → dedicated Save button in those statuses.
export const LINE_ACTUAL_EDITABLE_STATUSES: readonly WorkOrderStatus[] = Object.freeze([
  ...EDITABLE_STATUSES,
  'IN_PROGRESS',
  'ON_HOLD',
]);
// A5: гейт «Оновити рахунок з наряду» (refreshFromWorkOrder) — єдине джерело WO_INVOICEABLE_STATUSES
// у @sto/shared. Акт і створення рахунку — ширше: WO_COMPLETION_ACT_STATUSES / WO_INVOICE_CREATABLE_STATUSES.
export const INVOICEABLE_STATUSES: readonly WorkOrderStatus[] =
  asWoStatuses(WO_INVOICEABLE_STATUSES);
// BR-WO-021, BR-PL-011: наряд, під який закуповують товар і тримають резерв (не завершений і не
// скасований). Єдине джерело — WO_PROCUREMENT_ACTIVE_STATUSES у @sto/shared.
export const PROCUREMENT_ACTIVE_STATUSES: readonly WorkOrderStatus[] = asWoStatuses(
  WO_PROCUREMENT_ACTIVE_STATUSES,
);
// A5: share/print/SMS gate — єдине джерело WO_SHAREABLE_STATUSES у @sto/shared.
export const SHAREABLE_STATUSES: readonly WorkOrderStatus[] = asWoStatuses(WO_SHAREABLE_STATUSES);

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
