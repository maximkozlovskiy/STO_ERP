import { BadRequestException } from '@nestjs/common';
import type { Prisma, WorkOrderStatus } from '@prisma/client';
import { translateError } from '@sto/shared';
import { assertFsmTransition } from '../../common/utils/fsm';
import { moneyFromDecimal } from '../../common/utils/money';
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

/**
 * Сторно оплати наряду (BR-CASH-024): «Оплачено» → «Виставлено» разом зі зменшенням «сплачено».
 *
 * Це НЕ перехід FSM-карти: `WORK_ORDER_TRANSITIONS` зворотного PAID → INVOICED не має і не
 * отримує (користувач не може «розоплатити» наряд кнопкою). Єдиний викликач — сторно касової
 * оплати (`PaymentsService.reverse`), у своїй транзакції; запис тут, а не там, бо статус наряду
 * пишуть лише два файли (BR-WO-001). Side-effects у переході немає: PAID не резервує, не списує
 * й не нараховує. CAS — по статусу PAID і по прочитаному «сплачено» (паралельна оплата чи друге
 * сторно → 400). Подію / аудит викликач пише сам після коміту.
 */
export async function reopenPaidWorkOrderInTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  workOrderId: string,
  paidAmountBefore: Prisma.Decimal,
  paidAmountAfter: number,
): Promise<void> {
  const cas = await tx.workOrder.updateMany({
    where: {
      id: workOrderId,
      orgId,
      deletedAt: null,
      status: 'PAID',
      paidAmount: paidAmountBefore,
    },
    data: { status: 'INVOICED', paidAmount: paidAmountAfter },
  });
  if (cas.count === 0) {
    throw new BadRequestException(translateError('err.workOrder.statusChanged', getLocale()));
  }
}

/** Перехід статусу, зроблений у транзакції, — викликач емітить для нього подію ПІСЛЯ коміту. */
export interface WorkOrderStatusStep {
  from: WorkOrderStatus;
  to: WorkOrderStatus;
}

/** Наряд сплачено повністю: є що сплачувати і «сплачено» покриває «Разом» (BR-WO-016). */
export function isWorkOrderFullyPaid(
  totalAmount: Prisma.Decimal | number,
  paidAmount: Prisma.Decimal | number,
): boolean {
  const total = moneyFromDecimal(totalAmount);
  return total > 0 && moneyFromDecimal(paidAmount) >= total - 1e-9;
}

/**
 * BR-WO-016 / BR-PAY-005: повністю сплачений наряд сам іде до «Оплачено» — у ТІЙ САМІЙ транзакції,
 * що зробила його сплаченим (оплата) або довела до боргу (перехід у «Виконано» / «Виставлено»).
 * «Виконано» → «Виставлено» → «Оплачено» без створення рахунку; «Виставлено» → «Оплачено».
 * Інші статуси й неповна оплата — нічого. Обидва кроки — `transitionWorkOrderStatusInTx` (FSM +
 * CAS); повертає зроблені кроки, події TRANSITIONED викликач емітить після коміту.
 */
export async function settleIfFullyPaidInTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  workOrderId: string,
): Promise<WorkOrderStatusStep[]> {
  const wo = await tx.workOrder.findFirst({
    where: { id: workOrderId, orgId, deletedAt: null },
    select: { status: true, totalAmount: true, paidAmount: true },
  });
  if (!wo || !isWorkOrderFullyPaid(wo.totalAmount, wo.paidAmount)) return [];
  const steps: WorkOrderStatusStep[] = [];
  let status = wo.status;
  if (status === 'COMPLETED') {
    await transitionWorkOrderStatusInTx(tx, orgId, workOrderId, 'COMPLETED', 'INVOICED');
    steps.push({ from: 'COMPLETED', to: 'INVOICED' });
    status = 'INVOICED';
  }
  if (status === 'INVOICED') {
    await transitionWorkOrderStatusInTx(tx, orgId, workOrderId, 'INVOICED', 'PAID');
    steps.push({ from: 'INVOICED', to: 'PAID' });
  }
  return steps;
}
