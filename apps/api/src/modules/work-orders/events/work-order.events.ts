import type { WorkOrderStatus, RepairCategory } from '@prisma/client';

/**
 * A2 (архітектурне покращення): доменні події наряду. Раніше lifecycle-side-effects (пробіг / ТО /
 * гарантія / нотифікація / аудит) були захардкоджені inline у WorkOrdersService.transition() каскадом
 * fire-and-forget `.catch(warn)` — це давало God-service (знав про warranty/ТО/notify) + крихкість.
 *
 * Тепер transition() ЕМІТИТЬ подію ПІСЛЯ коміту транзакції, а незалежні @OnEvent-хендлери реагують.
 * Семантика доставки збережена: in-process EventEmitter2, best-effort (як було inline .catch), post-commit.
 * WorkOrdersService більше не залежить від warranties/maintenance/notifications заради цих реакцій.
 *
 * ⚠️ Гарантована доставка (transactional outbox) — окремий крок (A2-follow): зараз, як і раніше,
 * ефект може тихо не відпрацювати при краші процесу між комітом і хендлером.
 */

/** Іменем події користуються @OnEvent-декоратори. Тримати в синхроні з константами нижче. */
export const WORK_ORDER_EVENTS = {
  TRANSITIONED: 'work-order.transitioned',
  COMPLETED: 'work-order.completed',
} as const;

/** Емітиться на КОЖЕН FSM-перехід наряду (для аудиту статусу). */
export class WorkOrderTransitionedEvent {
  constructor(
    readonly orgId: string,
    readonly workOrderId: string,
    readonly fromStatus: WorkOrderStatus,
    readonly toStatus: WorkOrderStatus,
    /** Хто ініціював перехід (для audit-запису). undefined = системний виклик → аудит пропускається. */
    readonly userId?: string,
  ) {}
}

/** Емітиться коли наряд переходить у COMPLETED. Несе все потрібне хендлерам без re-fetch WO. */
export class WorkOrderCompletedEvent {
  constructor(
    readonly orgId: string,
    readonly workOrderId: string,
    readonly vehicleId: string,
    readonly completedAt: Date,
    readonly repairCategory: RepairCategory | null,
    readonly outMileage: number | null,
    readonly workOrderNumber: string,
    readonly branchId: string,
    readonly counterparty: {
      phone: string | null;
      email: string | null;
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
    },
  ) {}
}
