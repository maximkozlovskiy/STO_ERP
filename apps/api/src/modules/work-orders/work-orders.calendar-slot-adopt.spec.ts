/**
 * BR-WO-020 (скарга власника 2026-11-13) — наряд, створений із форми НАЯВНОГО запису календаря без
 * наряду (кнопка «створити наряд» у «Редагуванні слоту»): `POST /work-orders` з `calendarSlotId`
 * прив'язує САМ запис (увесь ручний ланцюжок) до нового наряду й ставить його на дати й підйомник
 * наряду, як перев'язка BR-WO-028; нового запису не створює, зайнятість — без цього ланцюжка. Запис
 * уже з нарядом, видалений, чужої організації, службовий чи не того клієнта / авто → 400, наряд не
 * створюється.
 *
 * Справжні WorkOrdersService + CalendarService над таблицями в пам'яті
 * (`work-orders.planning.spec-fixture.ts`): `where` виконується, тож видно, ЯКИЙ запис прив'язано.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import {
  CLIENT,
  LIFT_1,
  LIFT_2,
  MECH_BOTH,
  NOW,
  OTHER_ORG,
  OTHER_WO,
  ORG,
  VEHICLE,
  createDto,
  kyiv,
  planningHarness,
  slotRow,
  woRow,
} from './work-orders.planning.spec-fixture';

const D = '2026-05-22';
const D2 = '2026-05-23';
const SLOT = '81111111-1111-4111-8111-111111111111';
const CONT = '81111111-1111-4111-8111-222222222222';
const OTHER_CLIENT = '51111111-1111-4111-8111-999999999999';
const OTHER_VEHICLE = '41111111-1111-4111-8111-999999999999';

const t = (d: unknown) => (d as Date).getTime();
const msg = (key: string) => translateError(key, 'uk');

/** Ручний запис SLOT (без наряду) клієнта CLIENT на LIFT_1, D 10:00–12:00, з механіком. */
const manual = (over: Record<string, unknown> = {}) =>
  slotRow(SLOT, {
    workOrderId: null,
    counterpartyId: CLIENT,
    employeeId: MECH_BOTH,
    notes: 'Заміна масла',
    ...over,
  });

const adoptDto = (over: Record<string, unknown> = {}) =>
  createDto({
    calendarSlotId: SLOT,
    liftId: LIFT_1,
    plannedAt: kyiv(D, '10:00').toISOString(),
    dueDate: kyiv(D, '12:00').toISOString(),
    ...over,
  });

const allLive = (h: ReturnType<typeof planningHarness>) =>
  h.calendarSlot.rows.filter(r => r.deletedAt === null);

describe('WorkOrdersService.create з calendarSlotId — наряд забирає наявний запис (BR-WO-020)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-WO-020
  it("той самий час і підйомник: запис прив'язано до наряду, другого запису немає", async () => {
    const h = planningHarness({ workOrders: [], slots: [manual()] });
    const wo = await h.service.create(ORG, adoptDto());

    expect(wo.plannedAt).toBe(kyiv(D, '10:00').toISOString());
    expect(wo.dueDate).toBe(kyiv(D, '12:00').toISOString());
    expect(allLive(h)).toHaveLength(1);
    expect(h.liveSlots(wo.id)).toEqual([
      expect.objectContaining({
        id: SLOT,
        workOrderId: wo.id,
        liftId: LIFT_1,
        counterpartyId: CLIENT,
        vehicleId: VEHICLE,
        // Механік і примітка запису лишаються (підйомник той самий).
        employeeId: MECH_BOTH,
        notes: 'Заміна масла',
      }),
    ]);
  });

  // guards: BR-WO-020
  it('без calendarSlotId той самий час — «Підйомник зайнятий» (власним записом): так було до правки', async () => {
    const h = planningHarness({ workOrders: [], slots: [manual()] });
    const { calendarSlotId: _drop, ...dto } = adoptDto() as Record<string, unknown>;
    await expect(h.service.create(ORG, dto as never)).rejects.toThrow(msg('err.calendar.liftBusy'));
  });

  // guards: BR-WO-020
  it('незбережені в формі дати й підйомник: запис стає на дати й підйомник наряду', async () => {
    const h = planningHarness({ workOrders: [], slots: [manual()] });
    const wo = await h.service.create(
      ORG,
      adoptDto({
        liftId: LIFT_2,
        plannedAt: kyiv(D, '13:00').toISOString(),
        dueDate: kyiv(D, '16:00').toISOString(),
        plannedHours: 3,
      }),
    );
    const [slot, ...rest] = h.liveSlots(wo.id);
    expect(rest).toHaveLength(0);
    expect(slot).toMatchObject({ id: SLOT, liftId: LIFT_2 });
    expect(t(slot!.startAt)).toBe(t(kyiv(D, '13:00')));
    expect(t(slot!.endAt)).toBe(t(kyiv(D, '16:00')));
    expect(allLive(h)).toHaveLength(1);
  });

  // guards: BR-WO-020
  it('ручний ланцюжок на два дні (з продовження): увесь ланцюжок — записи наряду, якір той самий', async () => {
    const h = planningHarness({
      workOrders: [],
      slots: [
        manual({ startAt: kyiv(D, '14:00'), endAt: kyiv(D, '18:00') }),
        slotRow(CONT, {
          workOrderId: null,
          counterpartyId: CLIENT,
          parentSlotId: SLOT,
          startAt: kyiv(D2, '08:00'),
          endAt: kyiv(D2, '10:00'),
        }),
      ],
    });
    const wo = await h.service.create(
      ORG,
      adoptDto({
        calendarSlotId: CONT,
        plannedAt: kyiv(D, '14:00').toISOString(),
        dueDate: kyiv(D2, '10:00').toISOString(),
      }),
    );
    const live = h.liveSlots(wo.id).sort((a, b) => t(a.startAt) - t(b.startAt));
    expect(live).toHaveLength(2);
    expect(live[0]).toMatchObject({ id: SLOT, parentSlotId: null });
    expect(live[1]).toMatchObject({ parentSlotId: SLOT });
    expect(t(live[1]!.endAt)).toBe(t(kyiv(D2, '10:00')));
    // Ручних частин без наряду не лишилось.
    expect(allLive(h).filter(r => r.workOrderId === null)).toHaveLength(0);
  });

  // guards: BR-WO-020
  it.each([
    [
      'видалений запис',
      { deletedAt: new Date('2026-05-01') },
      'err.workOrder.calendarSlotNotFound',
    ],
    ['запис чужої організації', { orgId: OTHER_ORG }, 'err.workOrder.calendarSlotNotFound'],
    ['запис уже з нарядом', { workOrderId: OTHER_WO }, 'err.workOrder.calendarSlotHasWorkOrder'],
    [
      'запис іншого клієнта',
      { counterpartyId: OTHER_CLIENT },
      'err.workOrder.calendarSlotOtherClient',
    ],
    ['запис іншого авто', { vehicleId: OTHER_VEHICLE }, 'err.workOrder.calendarSlotOtherClient'],
    [
      'службовий запис (BR-CAL-003)',
      { type: 'BREAK', counterpartyId: null },
      'err.calendar.serviceSlotNoClient',
    ],
  ])('%s → 400, наряд не створюється, запис не змінено', async (_l, over, key) => {
    const h = planningHarness({
      workOrders: [woRow({ id: OTHER_WO, number: 'НРД-9' })],
      slots: [manual(over)],
    });
    const before = structuredClone(h.calendarSlot.rows);
    const err = await h.service.create(ORG, adoptDto()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe(msg(key));
    expect(h.workOrder.rows).toHaveLength(1);
    expect(h.calendarSlot.rows).toEqual(before);
    // Відмова до номера — номер документа не спалено.
    expect(h.docNumbers.next).not.toHaveBeenCalled();
  });

  // guards: BR-WO-020
  it('без планових дат → 400 «потребує планових початку й завершення»', async () => {
    const h = planningHarness({ workOrders: [], slots: [manual()] });
    await expect(
      h.service.create(ORG, adoptDto({ plannedAt: undefined, dueDate: undefined })),
    ).rejects.toThrow(msg('err.workOrder.calendarSlotNeedsDates'));
    expect(h.workOrder.rows).toHaveLength(0);
    expect(h.liveSlots(SLOT)).toHaveLength(0);
    expect(allLive(h)[0]).toMatchObject({ id: SLOT, workOrderId: null });
  });

  // guards: BR-WO-020
  it("запис прив'язали до іншого наряду між перевіркою й транзакцією → 400, наряд відкочено", async () => {
    const h = planningHarness({
      workOrders: [woRow({ id: OTHER_WO, number: 'НРД-9' })],
      slots: [manual()],
    });
    // Перевірка бачить запис вільним, а до транзакції його вже забрав інший наряд.
    const findFirst = h.calendarSlot.findFirst.getMockImplementation()!;
    h.calendarSlot.findFirst.mockImplementation(async (args: { where: { id?: unknown } }) => {
      // Копія: перевірка тримає прочитаний рядок, а таблиця в пам'яті віддає сам об'єкт.
      const row = structuredClone(await findFirst(args as never));
      if (args.where.id === SLOT && h.calendarSlot.rows[0]!.workOrderId === null) {
        h.calendarSlot.rows[0]!.workOrderId = OTHER_WO;
      }
      return row;
    });
    await expect(h.service.create(ORG, adoptDto())).rejects.toThrow(
      msg('err.workOrder.calendarSlotHasWorkOrder'),
    );
    // Номер узято (перевірка пройшла), але наряд відкочено разом із транзакцією.
    expect(h.docNumbers.next).toHaveBeenCalledTimes(1);
    expect(h.workOrder.rows).toHaveLength(1);
    expect(h.calendarSlot.rows[0]).toMatchObject({ id: SLOT, workOrderId: OTHER_WO });
  });
});
