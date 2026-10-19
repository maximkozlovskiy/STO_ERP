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

/**
 * Bug #910: скасування (чи «В роботу»), що встигло між перевіркою статусу і транзакцією запису
 * наряду. Транзакція переходу вже прибрала записи; запис календаря після неї не з'являється, дати
 * наряду не змінюються — статус стоїть в умові самого запису наряду.
 */
describe('Зміна запису наряду ‖ скасування наряду (Bug #910)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const CANCELLED_MSG = 'Наряд скасовано — записати його в календар не можна';

  /** Наряд APPROVED на LIFT_1 з датами D 10:00–12:00 і записом `anchor` (або без дат і записів). */
  function approved(withDates = true) {
    return planningHarness({
      workOrders: [
        woRow({
          status: 'APPROVED',
          liftId: withDates ? LIFT_1 : null,
          plannedAt: withDates ? kyiv(D, '10:00') : null,
          dueDate: withDates ? kyiv(D, '12:00') : null,
        }),
      ],
      slots: withDates ? [slotRow('anchor', { startAt: kyiv(D, '10:00') })] : [],
    });
  }

  /** Перехід у `status`, закомічений перед транзакцією зміни (скасування прибирає записи). */
  function transitionBeforeTx(h: ReturnType<typeof approved>, status: string) {
    const original = h.prisma.$transaction.getMockImplementation()!;
    h.prisma.$transaction.mockImplementationOnce(async cb => {
      h.workOrder.rows.find(w => w.id === WO_ID)!.status = status;
      if (status === 'CANCELLED')
        for (const s of h.calendarSlot.rows) if (s.workOrderId === WO_ID) s.deletedAt = new Date();
      return original(cb);
    });
  }

  // guards: BR-WO-022
  it('новий запис із нарядом без дат («+ Слот») → 400, запису немає, дат у наряду немає', async () => {
    const h = approved(false);
    transitionBeforeTx(h, 'CANCELLED');

    await expect(
      h.service.createCalendarSlot(ORG, {
        workOrderId: WO_ID,
        liftId: LIFT_1,
        startAt: kyiv(D, '13:00').toISOString(),
        endAt: kyiv(D, '14:00').toISOString(),
      } as never),
    ).rejects.toThrow(CANCELLED_MSG);

    expect(h.liveSlots()).toEqual([]);
    expect(h.workOrder.rows[0]).toMatchObject({ status: 'CANCELLED', plannedAt: null });
  });

  // guards: BR-WO-022
  it('зміна меж запису наряду → 400, запис не повертається, дати наряду ті самі', async () => {
    const h = approved();
    transitionBeforeTx(h, 'CANCELLED');

    await expect(
      h.service.updateCalendarSlot(ORG, 'anchor', {
        startAt: kyiv(D, '13:00').toISOString(),
        endAt: kyiv(D, '15:00').toISOString(),
      }),
    ).rejects.toThrow(CANCELLED_MSG);

    expect(h.liveSlots()).toEqual([]);
    expect(h.workOrder.rows[0].plannedAt).toEqual(kyiv(D, '10:00'));
  });

  // guards: BR-WO-027
  it('наряд став «В роботі» → зміна меж запису 400, запис і дати наряду на місці', async () => {
    const h = approved();
    transitionBeforeTx(h, 'IN_PROGRESS');

    await expect(
      h.service.updateCalendarSlot(ORG, 'anchor', {
        startAt: kyiv(D, '13:00').toISOString(),
        endAt: kyiv(D, '15:00').toISOString(),
      }),
    ).rejects.toThrow('Час і підйомник запису наряду змінюються лише');

    expect(h.liveSlots().map(s => [s.id, s.startAt])).toEqual([['anchor', kyiv(D, '10:00')]]);
    expect(h.workOrder.rows[0].plannedAt).toEqual(kyiv(D, '10:00'));
  });

  // guards: BR-WO-022
  it('картка: нові дати наряду → 400 «закритий наряд», запису немає', async () => {
    const h = approved();
    transitionBeforeTx(h, 'CANCELLED');

    await expect(
      h.service.update(ORG, WO_ID, {
        plannedAt: kyiv(D, '13:00').toISOString(),
        dueDate: kyiv(D, '15:00').toISOString(),
      } as never),
    ).rejects.toThrow('Не можна редагувати закритий наряд');

    expect(h.liveSlots()).toEqual([]);
    expect(h.workOrder.rows[0].plannedAt).toEqual(kyiv(D, '10:00'));
  });
});
