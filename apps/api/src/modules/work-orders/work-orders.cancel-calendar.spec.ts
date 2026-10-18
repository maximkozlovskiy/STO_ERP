/**
 * BR-WO-022 — скасування наряду звільняє календар (рішення власника 2026-10-18, як BR-WO-017 для
 * видалення). Перехід у «Скасовано» з будь-якого статусу, зокрема з «Виконано», у тій самій
 * транзакції позначає видаленими всі записи календаря наряду (якір і продовження) — підйомник і
 * механік звільняються; записи скасованих нарядів ніде не показуються.
 *
 * Справжні WorkOrdersService + CalendarService над таблицями в пам'яті
 * (`work-orders.planning.spec-fixture.ts`): `where` виконується по-справжньому, `$transaction`
 * відкочує таблиці при винятку.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkOrderStatus } from '@prisma/client';
import { WORK_ORDER_TRANSITIONS } from './work-orders.fsm';
import {
  LIFT_1,
  MECH_1,
  NOW,
  ORG,
  OTHER_ORG,
  OTHER_WO,
  WO_ID,
  kyiv,
  planningHarness,
  slotRow,
  woRow,
} from './work-orders.planning.spec-fixture';

const D = '2026-05-22';
const D2 = '2026-05-23';

/** Наряд WO_ID (статус `status`) з дводенним записом: якір D і продовження D2. */
function cancellable(status: string, extraSlots: Record<string, unknown>[] = []) {
  const h = planningHarness({
    workOrders: [
      woRow({
        status,
        liftId: LIFT_1,
        plannedAt: kyiv(D, '16:00'),
        dueDate: kyiv(D2, '10:00'),
      }),
      woRow({ id: OTHER_WO, number: 'НРД-9', status: 'APPROVED' }),
    ],
    slots: [
      slotRow('anchor', {
        employeeId: MECH_1,
        startAt: kyiv(D, '16:00'),
        endAt: kyiv(D, '18:00'),
      }),
      slotRow('cont', {
        employeeId: MECH_1,
        parentSlotId: 'anchor',
        startAt: kyiv(D2, '08:00'),
        endAt: kyiv(D2, '10:00'),
      }),
      ...(extraSlots as never[]),
    ],
  });
  // Як Prisma: прочитаний рядок — копія. Таблиця в пам'яті віддає живий рядок, і CAS переходу
  // змінив би вже прочитаний статус («Виконано» читалось би як «Скасовано»).
  const read = h.workOrder.findFirst.getMockImplementation()!;
  h.workOrder.findFirst.mockImplementation(async (args?: unknown) => {
    const row = await read(args as never);
    return row && { ...row };
  });
  return h;
}

const CANCEL_SOURCES = (Object.keys(WORK_ORDER_TRANSITIONS) as WorkOrderStatus[]).filter(s =>
  WORK_ORDER_TRANSITIONS[s].includes('CANCELLED' as WorkOrderStatus),
);

describe('WorkOrdersService.transition → CANCELLED — записи календаря наряду (BR-WO-022)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('скасувати можна щонайменше з чернетки, «Призупинено» й «Виконано» (контроль переліку)', () => {
    expect(CANCEL_SOURCES).toEqual(expect.arrayContaining(['DRAFT', 'ON_HOLD', 'COMPLETED']));
  });

  // guards: BR-WO-022
  it.each(CANCEL_SOURCES)(
    '%s → CANCELLED: якір і продовження позначено видаленими в транзакції переходу',
    async from => {
      const h = cancellable(from);

      await h.service.transition(ORG, WO_ID, 'CANCELLED' as never, 'u');

      expect(h.workOrder.rows.find(w => w.id === WO_ID)!.status).toBe('CANCELLED');
      expect(h.liveSlots()).toEqual([]);
      const byId = (id: string) => h.calendarSlot.rows.find(r => r.id === id)!;
      expect(byId('anchor').deletedAt).toBeInstanceOf(Date);
      expect(byId('cont').deletedAt).toBeInstanceOf(Date);
      expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    },
  );

  // guards: BR-WO-022
  it('«Виконано» → «Скасовано»: записи звільнено разом із поверненням складу й боргу', async () => {
    const h = cancellable('COMPLETED');

    await h.service.transition(ORG, WO_ID, 'CANCELLED' as never, 'u');

    expect(h.stockEffects.returnPartsAndCredit).toHaveBeenCalledTimes(1);
    expect(h.liveSlots()).toEqual([]);
  });

  // guards: BR-WO-022
  it('чужі записи не чіпає: інший наряд, запис без наряду, інша організація з тим самим наряду', async () => {
    const h = cancellable('APPROVED', [
      slotRow('other-wo', { workOrderId: OTHER_WO, liftId: null }),
      slotRow('no-wo', { workOrderId: null, liftId: null }),
      slotRow('foreign', { orgId: OTHER_ORG, liftId: null }),
    ]);

    await h.service.transition(ORG, WO_ID, 'CANCELLED' as never, 'u');

    const live = h.calendarSlot.rows.filter(r => r.deletedAt === null).map(r => r.id);
    expect(live.sort()).toEqual(['foreign', 'no-wo', 'other-wo']);
  });

  // guards: BR-WO-022
  it('скасування не відбулось (оплата між читанням і записом) → записи календаря живі', async () => {
    const h = cancellable('APPROVED');
    h.workOrder.findFirst.mockImplementationOnce(() => {
      const snapshot = { ...h.workOrder.rows.find(w => w.id === WO_ID)! };
      h.workOrder.rows.find(w => w.id === WO_ID)!.paidAmount = 80;
      return Promise.resolve(snapshot);
    });

    await expect(h.service.transition(ORG, WO_ID, 'CANCELLED' as never, 'u')).rejects.toThrow();

    expect(h.workOrder.rows.find(w => w.id === WO_ID)!.status).toBe('APPROVED');
    expect(
      h
        .liveSlots()
        .map(s => s.id)
        .sort(),
    ).toEqual(['anchor', 'cont']);
  });

  it('інший перехід (чернетка → кошторис) записів не чіпає (контроль)', async () => {
    const h = cancellable('DRAFT');

    await h.service.transition(ORG, WO_ID, 'ESTIMATE' as never, 'u');

    expect(
      h
        .liveSlots()
        .map(s => s.id)
        .sort(),
    ).toEqual(['anchor', 'cont']);
  });

  // guards: BR-WO-022
  it('після скасування підйомник вільний: інший наряд стає на той самий час', async () => {
    const h = cancellable('APPROVED');
    await h.service.transition(ORG, WO_ID, 'CANCELLED' as never, 'u');

    await h.service.update(ORG, OTHER_WO, {
      liftId: LIFT_1,
      plannedAt: kyiv(D, '16:00').toISOString(),
      dueDate: kyiv(D, '18:00').toISOString(),
    } as never);

    expect(h.liveSlots(OTHER_WO)).toHaveLength(1);
  });

  // guards: BR-WO-022
  it('запис наряду, скасованого раніше (дані до 2026-10-18), не показується й не займає підйомник', async () => {
    const h = cancellable('CANCELLED');

    const shown = await h.calendar.findSlots(ORG, D, 'ADMIN');
    expect(shown.map(s => s.id)).toEqual([]);

    await h.service.update(ORG, OTHER_WO, {
      liftId: LIFT_1,
      plannedAt: kyiv(D, '16:00').toISOString(),
      dueDate: kyiv(D, '18:00').toISOString(),
    } as never);
    expect(h.liveSlots(OTHER_WO)).toHaveLength(1);
  });
});
