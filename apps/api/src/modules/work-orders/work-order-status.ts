import { BadRequestException } from '@nestjs/common';
import type { Prisma, WorkOrderStatus } from '@prisma/client';
import { translateError } from '@sto/shared';
import { assertFsmTransition } from '../../common/utils/fsm';
import { getLocale } from '../../common/tenant/tenant-context';
import { WORK_ORDER_TRANSITIONS } from './work-orders.fsm';

/**
 * Чи можна ввійти в статус ЗВІДСИ, тобто без `WorkOrdersService.transition()`.
 *
 * `false` — вхід у статус несе там side-effects, яких хелпер не виконує:
 *  - IN_PROGRESS: резерв запчастин (при вході з APPROVED; ON_HOLD→IN_PROGRESS ефектів не має,
 *    але заборонений тут разом з усією ціллю — простіше й безпечніше, ніж розрізняти `from`);
 *  - COMPLETED: списання + CHARGE, `completedAt`, подія `WORK_ORDER_EVENTS.COMPLETED`
 *    (пробіг, ТО, гарантія, сповіщення клієнту);
 *  - CANCELLED: зняття резерву або реверс складу й боргу.
 * `true` — `transition()` для цієї цілі робить лише CAS і подію TRANSITIONED (звірено з усіма
 * гілками `transition()` 2026-10-07).
 *
 * `Record`, а не список заборонених: новий статус у `WorkOrderStatus` не скомпілюється, доки тут
 * не вирішено, чи має він side-effects. Зі списком заборон він мовчки став би дозволеним.
 */
const ALLOWED_WITHOUT_SIDE_EFFECTS: Record<WorkOrderStatus, boolean> = {
  DRAFT: true,
  ESTIMATE: true,
  APPROVED: true,
  ON_HOLD: true,
  INVOICED: true,
  PAID: true,
  ARCHIVED: true,
  IN_PROGRESS: false,
  COMPLETED: false,
  CANCELLED: false,
};

/**
 * Перехід статусу наряду ВСЕРЕДИНІ чужої транзакції — для модулів, яким зміна статусу наряду
 * потрібна атомарно зі своїм записом (підписання акта → INVOICED).
 *
 * НАВІЩО. `WorkOrdersService.transition()` відкриває власну транзакцію, тож викликати його
 * зсередини чужої не можна. Через це `CompletionActsService.sign()` писав
 * `workOrder.update({ data: { status: 'INVOICED' } })` напряму (BR-WO-001): без перевірки FSM,
 * без CAS — конкурентне скасування наряду мовчки перезаписувалось на INVOICED.
 *
 * Тут ті самі дві гарантії, що й у `transition()`: FSM-мапа і CAS по поточному статусу.
 * Подію `WORK_ORDER_EVENTS.TRANSITIONED` викликач емітить САМ після коміту своєї транзакції
 * (всередині не можна: транзакція ще може відкотитись).
 */
export async function transitionWorkOrderStatusInTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  workOrderId: string,
  from: WorkOrderStatus,
  to: WorkOrderStatus,
): Promise<void> {
  if (!ALLOWED_WITHOUT_SIDE_EFFECTS[to]) {
    throw new Error(
      `transitionWorkOrderStatusInTx: перехід у ${to} має side-effects — лише через WorkOrdersService.transition()`,
    );
  }
  assertFsmTransition(WORK_ORDER_TRANSITIONS, from, to);
  const cas = await tx.workOrder.updateMany({
    where: { id: workOrderId, orgId, deletedAt: null, status: from },
    data: { status: to },
  });
  if (cas.count === 0) {
    throw new BadRequestException(translateError('err.workOrder.statusChanged', getLocale()));
  }
}
