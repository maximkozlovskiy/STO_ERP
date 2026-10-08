// BR-WO-008: перехід у COMPLETED перераховує тотали наряду за чинними режимом і ставкою ПДВ —
// у тій самій транзакції і ДО нарахування боргу.
//
// Тотали наряду ліниві: пишуться при правці рядків. Наряд, створений до зміни налаштувань ПДВ
// і завершений без правок, ніс би стару суму, і клієнтові нарахували б борг за старим режимом.
//
// Mutation-verify: (1) прибрати виклик recalc → кейси 1 і 2 падають; (2) поставити recalc ПІСЛЯ
// writeOffPartsAndCharge → кейс «до нарахування боргу» падає; (3) викликати recalc на
// this.prisma замість tx → кейс про клієнта транзакції падає.

import { describe, it, expect, vi } from 'vitest';
import { WorkOrdersService } from './work-orders.service';
import type { PrismaService } from '../../prisma/prisma.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const WO_ID = '22222222-2222-4222-8222-222222222222';

function setup(preStatus: string) {
  const order: string[] = [];
  const row = {
    id: WO_ID,
    orgId: ORG,
    branchId: 'b',
    vehicleId: 'v',
    counterpartyId: 'c',
    number: 'НРД-1',
    status: preStatus,
    priority: 'NORMAL',
    repairCategory: null,
    description: null,
    inMileage: null,
    outMileage: null,
    plannedAt: null,
    dueDate: null,
    completedAt: null,
    warrantyUntil: null,
    clientApproval: false,
    totalLabor: 500,
    totalActualLabor: 500,
    totalParts: 0,
    totalNet: 500,
    totalAmount: 500,
    totalVat: 0,
    paidAmount: 0,
    documentDate: new Date('2026-10-08'),
    syncVersion: 0n,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    // крок сповіщень і подій після завершення читає контрагента, авто й філію
    counterparty: { phone: null, email: null, firstName: null, lastName: null, companyName: 'ТОВ' },
    vehicle: { make: 'Toyota', model: 'Camry', licensePlate: 'AA0000AA' },
    branch: { name: 'Головна' },
  };
  // tx — ОКРЕМИЙ об'єкт від prisma: так видно, на якому клієнті покликали recalc.
  const tx = {
    workOrder: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(row),
      findFirstOrThrow: vi.fn().mockResolvedValue(row),
    },
    workOrderPart: { findMany: vi.fn().mockResolvedValue([]) },
    completionAct: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  const prisma = {
    workOrder: {
      findFirst: vi.fn().mockResolvedValue(row),
      findFirstOrThrow: vi.fn().mockResolvedValue(row),
    },
    $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  } as unknown as PrismaService;

  const totals = {
    recalc: vi.fn().mockImplementation(() => {
      order.push('recalc');
      return Promise.resolve();
    }),
  };
  const stockEffects = {
    writeOffPartsAndCharge: vi.fn().mockImplementation(() => {
      order.push('charge');
      return Promise.resolve();
    }),
    reserveParts: vi.fn().mockResolvedValue(undefined),
    releasePartReservations: vi.fn().mockResolvedValue(undefined),
    returnPartsAndCredit: vi.fn().mockResolvedValue(undefined),
  };
  const service = new WorkOrdersService(
    prisma,
    stockEffects as never,
    null as never, // docNumbers
    null as never, // pdf
    { record: vi.fn().mockResolvedValue(undefined) } as never, // audit
    null as never, // settingsService
    null as never, // exchangeRates
    { emit: vi.fn(), emitAsync: vi.fn().mockResolvedValue([]) } as never, // events
    totals as never,
  );
  return { service, tx, totals, stockEffects, order };
}

describe('WorkOrdersService.transition → COMPLETED: перерахунок тоталів (BR-WO-008)', () => {
  // guards: BR-WO-008
  it('перераховує тотали ДО нарахування боргу', async () => {
    const { service, order } = setup('IN_PROGRESS');

    await service.transition(ORG, WO_ID, 'COMPLETED' as never, 'user-1');

    expect(order).toEqual(['recalc', 'charge']);
  });

  // guards: BR-WO-008
  it('перерахунок іде на клієнті ТІЄЇ САМОЇ транзакції, для цього наряду й організації', async () => {
    const { service, tx, totals } = setup('IN_PROGRESS');

    await service.transition(ORG, WO_ID, 'COMPLETED' as never, 'user-1');

    expect(totals.recalc).toHaveBeenCalledTimes(1);
    expect(totals.recalc).toHaveBeenCalledWith(WO_ID, tx, ORG);
  });

  // guards: BR-WO-008
  it('перерахунок упав → борг не нараховується (помилка виходить із транзакції)', async () => {
    const { service, totals, stockEffects } = setup('IN_PROGRESS');
    totals.recalc.mockRejectedValue(new Error('курс недоступний'));

    await expect(service.transition(ORG, WO_ID, 'COMPLETED' as never, 'user-1')).rejects.toThrow(
      'курс недоступний',
    );
    expect(stockEffects.writeOffPartsAndCharge).not.toHaveBeenCalled();
  });

  it('інші переходи тотали не перераховують (ESTIMATE → APPROVED)', async () => {
    const { service, totals } = setup('ESTIMATE');

    await service.transition(ORG, WO_ID, 'APPROVED' as never, 'user-1');

    expect(totals.recalc).not.toHaveBeenCalled();
  });
});
