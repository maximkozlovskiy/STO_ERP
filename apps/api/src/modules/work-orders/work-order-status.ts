import { BadRequestException } from '@nestjs/common';
import type { Prisma, WorkOrderStatus } from '@prisma/client';
import { translateError } from '@sto/shared';
import { assertFsmTransition } from '../../common/utils/fsm';
import { getLocale } from '../../common/tenant/tenant-context';
import { WORK_ORDER_TRANSITIONS } from './work-orders.fsm';

/**
 * Переходи, які несуть складські/фінансові side-effects (резерв, списання + CHARGE, реверс).
 * Їх виконує ЛИШЕ `WorkOrdersService.transition()` — звідси вони заборонені.
 */
const SIDE_EFFECT_TARGETS: readonly WorkOrderStatus[] = ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

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
  if (SIDE_EFFECT_TARGETS.includes(to)) {
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
