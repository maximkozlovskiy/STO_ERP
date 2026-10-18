/**
 * Запис наряду в календарі: видалення, статус наряду і перев'язка (рішення власника 2026-10-18).
 *
 * - BR-WO-026: видалення запису наряду (`DELETE /calendar/slots/:id`) позначає видаленим увесь
 *   ланцюжок записів наряду і стирає планові дати наряду (нормогодини, виведені з дат, — теж);
 *   журнал змін наряду фіксує стерті дати.
 * - BR-WO-027: час і підйомник запису наряду змінюються лише в статусах, де картка змінює дати
 *   (`WO_EDITABLE_STATUSES`); інакше 400 з причиною. Примітка й механік — як раніше.
 * - BR-WO-028: перев'язка запису на інший наряд ставить запис на дати й підйомник нового наряду
 *   (або дає йому свої); попередній наряд утрачає запис і дати. Обидва наряди — редаговані.
 *   Відв'язка («×») — втрата запису нарядом, як BR-WO-026.
 *
 * Справжні WorkOrdersService + CalendarService над таблицями в пам'яті
 * (`work-orders.planning.spec-fixture.ts`; `$transaction` відкочує таблиці при винятку).
 * «Зараз» — 20.05.2026 09:00 Києва; філія 08:00–18:00.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import {
  CLIENT,
  LIFT_1,
  LIFT_2,
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
const USER = 'user-1';
const t = (d: unknown) => (d as Date).getTime();
const iso = (day: string, hhmm: string) => kyiv(day, hhmm).toISOString();

type Harness = ReturnType<typeof planningHarness>;
type Row = Record<string, unknown>;

/**
 * WO_ID (D 10:00–12:00 на LIFT_1, «Нормогодин» 2 — виведені з дат) з якорем `anchor`; OTHER_WO —
 * за `other` (за замовчуванням чернетка без дат).
 */
function planned(over: { wo?: Row; other?: Row; anchor?: Row; extra?: Row[] } = {}) {
  return planningHarness({
    workOrders: [
      woRow({
        liftId: LIFT_1,
        plannedAt: kyiv(D, '10:00'),
        dueDate: kyiv(D, '12:00'),
        plannedHours: 2,
        ...over.wo,
      }),
      woRow({ id: OTHER_WO, number: 'НРД-9', ...over.other }),
    ],
    slots: [slotRow('anchor', over.anchor), ...((over.extra ?? []) as never[])],
  });
}

/** WO_ID на два дні: D 16:00 → D2 10:00 (якір D 16–18, продовження D2 08–10), «Нормогодин» 4. */
function twoDays(woOver: Row = {}) {
  return planningHarness({
    workOrders: [
      woRow({
        liftId: LIFT_1,
        plannedAt: kyiv(D, '16:00'),
        dueDate: kyiv(D2, '10:00'),
        plannedHours: 4,
        ...woOver,
      }),
      woRow({ id: OTHER_WO, number: 'НРД-9' }),
    ],
    slots: [
      slotRow('anchor', { startAt: kyiv(D, '16:00'), endAt: kyiv(D, '18:00') }),
      slotRow('cont', {
        parentSlotId: 'anchor',
        startAt: kyiv(D2, '08:00'),
        endAt: kyiv(D2, '10:00'),
      }),
    ],
  });
}

const woOf = (h: Harness, id = WO_ID) => h.workOrder.rows.find(w => w.id === id)!;
const slotOf = (h: Harness, id: string) => h.calendarSlot.rows.find(s => s.id === id)!;
const snapshot = (h: Harness) => structuredClone([h.workOrder.rows, h.calendarSlot.rows]);

async function rejected(h: Harness, p: Promise<unknown>, ErrorType = BadRequestException) {
  const before = snapshot(h);
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ErrorType);
  // Ні наряди, ні записи не змінились.
  expect(snapshot(h)).toEqual(before);
  return err as Error;
}

const msg = (key: string) => translateError(key, 'uk');

describe('Видалення запису наряду стирає дати наряду (BR-WO-026)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-WO-026
  it('якір дводенного запису → увесь ланцюжок видалено, дати й виведені нормогодини стерто, журнал наряду', async () => {
    const h = twoDays();

    await h.service.removeCalendarSlot(ORG, 'anchor', USER);

    // Наряд заблоковано (до записів календаря), його дати читаються під блокуванням.
    expect(h.prisma.$queryRaw).toHaveBeenCalledWith(expect.anything(), ORG, [WO_ID]);
    expect(h.liveSlots()).toEqual([]);
    expect(woOf(h)).toMatchObject({ plannedAt: null, dueDate: null, plannedHours: null });
    expect(h.audit.record).toHaveBeenCalledWith(
      ORG,
      'WorkOrder',
      WO_ID,
      'UPDATE',
      USER,
      { plannedAt: kyiv(D, '16:00'), dueDate: kyiv(D2, '10:00'), plannedHours: 4 },
      { plannedAt: null, dueDate: null, plannedHours: null },
    );
  });

  // guards: BR-WO-026
  it('продовження дводенного запису → так само весь ланцюжок і дати наряду', async () => {
    const h = twoDays();

    await h.service.removeCalendarSlot(ORG, 'cont', USER);

    expect(h.liveSlots()).toEqual([]);
    expect(woOf(h)).toMatchObject({ plannedAt: null, dueDate: null });
  });

  // guards: BR-WO-026
  it('другий запис того ж наряду теж видалено — наряд лишається без запису', async () => {
    const h = planned({
      extra: [slotRow('second', { startAt: kyiv(D2, '13:00'), endAt: kyiv(D2, '14:00') })],
    });

    await h.service.removeCalendarSlot(ORG, 'anchor', USER);

    expect(h.liveSlots()).toEqual([]);
  });

  // guards: BR-WO-026
  it('нормогодини, не виведені з дат (5 при 2 год між датами), лишаються', async () => {
    const h = planned({ wo: { plannedHours: 5 } });

    await h.service.removeCalendarSlot(ORG, 'anchor', USER);

    expect(woOf(h)).toMatchObject({ plannedAt: null, dueDate: null, plannedHours: 5 });
    expect(h.audit.record).toHaveBeenCalledWith(
      ORG,
      'WorkOrder',
      WO_ID,
      'UPDATE',
      USER,
      { plannedAt: kyiv(D, '10:00'), dueDate: kyiv(D, '12:00') },
      { plannedAt: null, dueDate: null },
    );
  });

  // guards: BR-WO-026
  it('запис без наряду → видалено лише його, наряд не чіпається', async () => {
    const h = planned({
      extra: [slotRow('plain', { workOrderId: null, counterpartyId: CLIENT, liftId: LIFT_2 })],
    });
    const before = structuredClone(woOf(h));

    await h.service.removeCalendarSlot(ORG, 'plain', USER);

    expect(slotOf(h, 'plain').deletedAt).toBeInstanceOf(Date);
    expect(h.liveSlots().map(s => s.id)).toEqual(['anchor']);
    expect(woOf(h)).toEqual(before);
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  // guards: BR-WO-026
  it('наряд без дат (запис привʼязано формою) → запис видалено, журнал не пишеться', async () => {
    const h = planned({ wo: { plannedAt: null, dueDate: null, plannedHours: 3 } });

    await h.service.removeCalendarSlot(ORG, 'anchor', USER);

    expect(h.liveSlots()).toEqual([]);
    expect(woOf(h).plannedHours).toBe(3);
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  // guards: BR-WO-026
  it('запис чужої організації → 404, нічого не змінено', async () => {
    const h = planned({ extra: [slotRow('foreign', { orgId: OTHER_ORG, liftId: LIFT_2 })] });

    await rejected(h, h.service.removeCalendarSlot(ORG, 'foreign', USER), NotFoundException);
  });
});

describe('Час і підйомник запису наряду — лише в редагованих статусах (BR-WO-027)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-WO-027
  it.each(['IN_PROGRESS', 'ON_HOLD', 'COMPLETED'])(
    'наряд «%s»: зміна меж запису → 400 з причиною, без змін',
    async status => {
      const h = planned({ wo: { status } });

      const err = await rejected(
        h,
        h.service.updateCalendarSlot(ORG, 'anchor', { endAt: iso(D, '13:00') }),
      );
      expect(err.message).toBe(msg('err.calendar.workOrderSlotLocked'));
    },
  );

  // guards: BR-WO-027
  it('наряд «В роботі»: інший підйомник у формі → 400, без змін', async () => {
    const h = planned({ wo: { status: 'IN_PROGRESS' } });

    const err = await rejected(
      h,
      h.service.updateCalendarSlot(ORG, 'anchor', {
        liftId: LIFT_2,
        startAt: iso(D, '10:00'),
        endAt: iso(D, '12:00'),
        workOrderId: WO_ID,
      }),
    );
    expect(err.message).toBe(msg('err.calendar.workOrderSlotLocked'));
  });

  // guards: BR-WO-027
  it('наряд «В роботі»: перетягування (reschedule) → 400, без змін', async () => {
    const h = planned({ wo: { status: 'IN_PROGRESS' } });

    const err = await rejected(
      h,
      h.service.reschedule(ORG, WO_ID, { slotId: 'anchor', startAt: iso(D, '13:00') }),
    );
    expect(err.message).toBe(msg('err.calendar.workOrderSlotLocked'));
  });

  // guards: BR-WO-027
  it('наряд «В роботі»: примітка й механік (час і підйомник ті самі) → записано, наряд не чіпається', async () => {
    const h = planned({ wo: { status: 'IN_PROGRESS' } });
    const before = structuredClone(woOf(h));

    await h.service.updateCalendarSlot(ORG, 'anchor', {
      liftId: LIFT_1,
      employeeId: MECH_1,
      startAt: iso(D, '10:00'),
      endAt: iso(D, '12:00'),
      notes: 'Клієнт чекає',
      workOrderId: WO_ID,
    });

    expect(woOf(h)).toEqual(before);
    expect(slotOf(h, 'anchor')).toMatchObject({ employeeId: MECH_1, notes: 'Клієнт чекає' });
  });

  /** Форма дводенного запису (`twoDays`): час і підйомник якоря ті самі, примітка й механік нові. */
  const chainNoteForm = {
    liftId: LIFT_1,
    employeeId: MECH_1,
    startAt: iso(D, '16:00'),
    endAt: iso(D, '18:00'),
    notes: 'Клієнт чекає',
    workOrderId: WO_ID,
  };

  // guards: BR-WO-027
  it.each(['COMPLETED', 'PAID', 'IN_PROGRESS'])(
    'наряд «%s»: примітка й механік дводенного запису → увесь ланцюжок без перебудови, наряд не чіпається',
    async status => {
      const h = twoDays({ status });
      const before = structuredClone(woOf(h));

      await h.service.updateCalendarSlot(ORG, 'anchor', chainNoteForm, USER);

      expect(woOf(h)).toEqual(before);
      // Ті самі записи (продовження не перебудовано) на тих самих місцях.
      expect(h.liveSlots()).toEqual([
        expect.objectContaining({
          id: 'anchor',
          employeeId: MECH_1,
          notes: 'Клієнт чекає',
          startAt: kyiv(D, '16:00'),
        }),
        expect.objectContaining({
          id: 'cont',
          employeeId: MECH_1,
          notes: 'Клієнт чекає',
          startAt: kyiv(D2, '08:00'),
        }),
      ]);
    },
  );

  // guards: BR-WO-027
  it('наряд «В роботі» без дат: примітка дводенного запису не дає наряду дат', async () => {
    const h = twoDays({
      status: 'IN_PROGRESS',
      plannedAt: null,
      dueDate: null,
      plannedHours: null,
    });

    await h.service.updateCalendarSlot(ORG, 'cont', { notes: 'Клієнт чекає' }, USER);

    expect(woOf(h)).toMatchObject({ plannedAt: null, dueDate: null, plannedHours: null });
    expect(slotOf(h, 'anchor').notes).toBe('Клієнт чекає');
  });

  // guards: BR-WO-027, BR-CAL-005
  it('наряд «Виконано»: механік зайнятий на другому дні ланцюжка → 400, нічого не змінено', async () => {
    const h = twoDays({ status: 'COMPLETED' });
    h.calendarSlot.rows.push(
      slotRow('busy', {
        workOrderId: null,
        liftId: LIFT_2,
        employeeId: MECH_1,
        startAt: kyiv(D2, '09:00'),
        endAt: kyiv(D2, '11:00'),
      }),
    );

    const err = await rejected(h, h.service.updateCalendarSlot(ORG, 'anchor', chainNoteForm, USER));
    expect(err.message).toBe(msg('err.calendar.employeeBusyNextDay'));
  });

  // guards: BR-WO-027
  it.each(['DRAFT', 'ESTIMATE', 'APPROVED'])(
    'наряд «%s»: зміна меж запису → дати наряду змінено',
    async status => {
      const h = planned({ wo: { status } });

      await h.service.updateCalendarSlot(ORG, 'anchor', { endAt: iso(D, '13:00') });

      expect(t(woOf(h).dueDate)).toBe(t(kyiv(D, '13:00')));
    },
  );
});

describe("Перев'язка запису на інший наряд (BR-WO-028)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Тіло форми запису: той самий час і підйомник якоря, інший наряд. */
  const relinkForm = (workOrderId: string | null, over: Row = {}) => ({
    workOrderId,
    liftId: LIFT_1,
    startAt: iso(D, '10:00'),
    endAt: iso(D, '12:00'),
    notes: "Перев'язано",
    ...over,
  });

  // guards: BR-WO-028
  it('новий наряд із датами → той самий запис на його дати й підйомник, його запис замінено, старий наряд без дат', async () => {
    const h = planned({
      // Запис нового наряду РАНІШЕ за перев'язаний: якір наряду обирається за часом, тож без
      // явної заміни лишився б він, а перев'язаний запис зник би.
      other: {
        liftId: LIFT_2,
        plannedAt: kyiv(D, '08:00'),
        dueDate: kyiv(D, '09:30'),
        plannedHours: 1.5,
      },
      extra: [
        slotRow('other-own', {
          workOrderId: OTHER_WO,
          liftId: LIFT_2,
          startAt: kyiv(D, '08:00'),
          endAt: kyiv(D, '09:30'),
        }),
      ],
    });

    const res = await h.service.updateCalendarSlot(ORG, 'anchor', relinkForm(OTHER_WO), USER);

    expect(res).toMatchObject({ id: 'anchor', workOrderId: OTHER_WO, startAt: iso(D, '08:00') });
    expect(h.liveSlots(OTHER_WO)).toEqual([
      expect.objectContaining({
        id: 'anchor',
        liftId: LIFT_2,
        startAt: kyiv(D, '08:00'),
        endAt: kyiv(D, '09:30'),
        notes: "Перев'язано",
        counterpartyId: CLIENT,
      }),
    ]);
    expect(slotOf(h, 'other-own').deletedAt).toBeInstanceOf(Date);
    expect(t(woOf(h, OTHER_WO).plannedAt)).toBe(t(kyiv(D, '08:00')));
    expect(h.liveSlots()).toEqual([]);
    expect(woOf(h)).toMatchObject({ plannedAt: null, dueDate: null, plannedHours: null });
    expect(h.audit.record).toHaveBeenCalledWith(
      ORG,
      'WorkOrder',
      WO_ID,
      'UPDATE',
      USER,
      expect.objectContaining({ plannedAt: kyiv(D, '10:00') }),
      expect.objectContaining({ plannedAt: null, dueDate: null }),
    );
  });

  // guards: BR-WO-028
  it('новий наряд без дат → дати й підйомник запису з форми стають його датами, нормогодини — робочі години', async () => {
    const h = planned({ other: { plannedHours: null } });

    await h.service.updateCalendarSlot(
      ORG,
      'anchor',
      relinkForm(OTHER_WO, { liftId: LIFT_2, startAt: iso(D, '13:00'), endAt: iso(D, '15:00') }),
      USER,
    );

    expect(woOf(h, OTHER_WO)).toMatchObject({ liftId: LIFT_2, plannedHours: 2 });
    expect(t(woOf(h, OTHER_WO).plannedAt)).toBe(t(kyiv(D, '13:00')));
    expect(t(woOf(h, OTHER_WO).dueDate)).toBe(t(kyiv(D, '15:00')));
    expect(h.liveSlots(OTHER_WO)).toEqual([
      expect.objectContaining({ id: 'anchor', liftId: LIFT_2, startAt: kyiv(D, '13:00') }),
    ]);
    expect(woOf(h)).toMatchObject({ plannedAt: null, dueDate: null });
  });

  // guards: BR-WO-028
  it('запис без наряду отримав наряд без дат → наряд бере дати й підйомник запису, інший наряд не чіпається', async () => {
    const h = planned({
      extra: [
        slotRow('plain', {
          workOrderId: null,
          counterpartyId: CLIENT,
          startAt: kyiv(D2, '13:00'),
          endAt: kyiv(D2, '14:00'),
        }),
      ],
    });
    const before = structuredClone(woOf(h));

    await h.service.updateCalendarSlot(ORG, 'plain', { workOrderId: OTHER_WO }, USER);

    expect(woOf(h, OTHER_WO)).toMatchObject({ liftId: LIFT_1, plannedHours: 1 });
    expect(t(woOf(h, OTHER_WO).plannedAt)).toBe(t(kyiv(D2, '13:00')));
    expect(h.liveSlots(OTHER_WO).map(s => s.id)).toEqual(['plain']);
    expect(woOf(h)).toEqual(before);
  });

  // guards: BR-WO-028
  it('дводенний ланцюжок → на наряд з одноденними датами: один запис на його датах', async () => {
    const h = twoDays();
    woOf(h, OTHER_WO).liftId = LIFT_1;
    woOf(h, OTHER_WO).plannedAt = kyiv(D2, '13:00');
    woOf(h, OTHER_WO).dueDate = kyiv(D2, '15:00');

    await h.service.updateCalendarSlot(ORG, 'cont', { workOrderId: OTHER_WO }, USER);

    expect(h.liveSlots(OTHER_WO)).toEqual([
      expect.objectContaining({
        id: 'anchor',
        startAt: kyiv(D2, '13:00'),
        endAt: kyiv(D2, '15:00'),
      }),
    ]);
    expect(h.liveSlots()).toEqual([]);
  });

  // guards: BR-WO-028, BR-WO-027
  it.each([
    ['попередній наряд «В роботі»', { wo: { status: 'IN_PROGRESS' } }],
    ['попередній наряд «Виконано»', { wo: { status: 'COMPLETED' } }],
    ['новий наряд «В роботі»', { other: { status: 'IN_PROGRESS' } }],
    ['новий наряд «Призупинено»', { other: { status: 'ON_HOLD' } }],
  ])('%s → 400 з причиною, нічого не змінено', async (_label, over) => {
    const h = planned(over);

    const err = await rejected(
      h,
      h.service.updateCalendarSlot(ORG, 'anchor', relinkForm(OTHER_WO), USER),
    );
    expect(err.message).toBe(msg('err.calendar.workOrderRelinkLocked'));
  });

  // guards: BR-WO-028, BR-WO-027
  it('наряди блокуються за id; новий наряд став «В роботі» до транзакції → 400, нічого не змінено', async () => {
    const h = planned();
    // Перехід нового наряду між перевіркою статусу і транзакцією перев'язки — у мить блокування.
    h.prisma.$queryRaw.mockImplementationOnce(async () => {
      woOf(h, OTHER_WO).status = 'IN_PROGRESS';
      return [];
    });

    const err = await rejected(
      h,
      h.service.updateCalendarSlot(ORG, 'anchor', relinkForm(OTHER_WO), USER),
    );
    expect(err.message).toBe(msg('err.calendar.workOrderRelinkLocked'));
    // Обидва наряди — одним блокуванням у порядку id (WO_ID < OTHER_WO), хоч новий — OTHER_WO.
    expect(h.prisma.$queryRaw.mock.calls[0]!.slice(1)).toEqual([ORG, [WO_ID, OTHER_WO]]);
  });

  // guards: BR-WO-028
  it('дати нового наряду зайняті на його підйомнику → 400 «зайнятий», ні наряди, ні записи не змінено', async () => {
    const h = planned({
      other: { liftId: LIFT_2, plannedAt: kyiv(D2, '13:00'), dueDate: kyiv(D2, '15:00') },
      extra: [
        slotRow('busy', {
          workOrderId: null,
          liftId: LIFT_2,
          startAt: kyiv(D2, '14:00'),
          endAt: kyiv(D2, '16:00'),
        }),
      ],
    });

    const err = await rejected(
      h,
      h.service.updateCalendarSlot(ORG, 'anchor', relinkForm(OTHER_WO), USER),
    );
    expect(err.message).toBe(msg('err.calendar.liftBusy'));
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  // guards: BR-WO-028, BR-CAL-012
  it('механік запису не закріплений за підйомником нового наряду → 400, нічого не змінено', async () => {
    const h = planned({
      anchor: { employeeId: MECH_1 },
      other: { liftId: LIFT_2, plannedAt: kyiv(D2, '13:00'), dueDate: kyiv(D2, '15:00') },
    });

    const err = await rejected(
      h,
      h.service.updateCalendarSlot(
        ORG,
        'anchor',
        relinkForm(OTHER_WO, { employeeId: MECH_1 }),
        USER,
      ),
    );
    expect(err.message).toBe(msg('err.calendar.employeeNotOnLift'));
  });

  // guards: BR-WO-028, BR-WO-026
  it('відвʼязка («×») → запис лишається без наряду з новим часом, наряд утратив дати', async () => {
    const h = planned();

    await h.service.updateCalendarSlot(
      ORG,
      'anchor',
      relinkForm(null, {
        counterpartyId: CLIENT,
        startAt: iso(D, '13:00'),
        endAt: iso(D, '14:00'),
      }),
      USER,
    );

    expect(slotOf(h, 'anchor')).toMatchObject({
      workOrderId: null,
      deletedAt: null,
      counterpartyId: CLIENT,
    });
    expect(t(slotOf(h, 'anchor').startAt)).toBe(t(kyiv(D, '13:00')));
    expect(woOf(h)).toMatchObject({ plannedAt: null, dueDate: null, plannedHours: null });
    expect(h.audit.record).toHaveBeenCalledTimes(1);
  });

  // guards: BR-WO-028, BR-WO-026
  it('відвʼязка продовження дводенного запису → увесь ланцюжок без наряду, дати наряду стерто', async () => {
    const h = twoDays();

    await h.service.updateCalendarSlot(ORG, 'cont', { workOrderId: null, counterpartyId: CLIENT });

    expect(h.liveSlots()).toEqual([]);
    expect([slotOf(h, 'anchor'), slotOf(h, 'cont')]).toEqual([
      expect.objectContaining({ workOrderId: null, deletedAt: null }),
      expect.objectContaining({ workOrderId: null, deletedAt: null }),
    ]);
    expect(woOf(h)).toMatchObject({ plannedAt: null, dueDate: null });
  });
});

describe("Відв'язка запису наряду: статус і багатоденний запис (BR-WO-028, Bug #906, #907)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Форма якоря дводенного запису: той самий день якоря (16–18), наряд «×». */
  const anchorForm = (over: Row = {}) => ({
    workOrderId: null,
    liftId: LIFT_1,
    startAt: iso(D, '16:00'),
    endAt: iso(D, '18:00'),
    counterpartyId: CLIENT,
    employeeId: null,
    notes: 'Відвʼязано',
    ...over,
  });

  // guards: BR-WO-028, BR-WO-026
  it('відвʼязка ЯКОРЯ дводенного запису з форми → увесь ланцюжок без наряду, примітка всьому ланцюжку, дати стерто (Bug #906)', async () => {
    const h = twoDays();

    const res = await h.service.updateCalendarSlot(ORG, 'anchor', anchorForm(), USER);

    expect(res).toMatchObject({ id: 'anchor', workOrderId: null });
    expect(h.liveSlots()).toEqual([]);
    expect([slotOf(h, 'anchor'), slotOf(h, 'cont')]).toEqual([
      expect.objectContaining({ workOrderId: null, deletedAt: null, notes: 'Відвʼязано' }),
      expect.objectContaining({ workOrderId: null, deletedAt: null, notes: 'Відвʼязано' }),
    ]);
    expect(slotOf(h, 'cont').counterpartyId).toBe(CLIENT);
    expect(t(slotOf(h, 'cont').startAt)).toBe(t(kyiv(D2, '08:00')));
    expect(woOf(h)).toMatchObject({ plannedAt: null, dueDate: null, plannedHours: null });
    expect(h.audit.record).toHaveBeenCalledTimes(1);
  });

  // guards: BR-WO-028
  it('відвʼязка дводенного запису з іншим часом → 400 «редагуйте кожен окремо», нічого не змінено', async () => {
    const h = twoDays();

    const err = await rejected(
      h,
      h.service.updateCalendarSlot(ORG, 'anchor', anchorForm({ startAt: iso(D, '15:00') }), USER),
    );
    expect(err.message).toBe(msg('err.calendar.slotSplitTwoDays'));
  });

  // guards: BR-WO-028, BR-CAL-012
  it('відвʼязка дводенного запису з механіком, не закріпленим за підйомником → 400, нічого не змінено', async () => {
    const h = twoDays({ liftId: LIFT_2 });
    slotOf(h, 'anchor').liftId = LIFT_2;
    slotOf(h, 'cont').liftId = LIFT_2;

    const err = await rejected(
      h,
      h.service.updateCalendarSlot(
        ORG,
        'anchor',
        anchorForm({ liftId: LIFT_2, employeeId: MECH_1 }),
        USER,
      ),
    );
    expect(err.message).toBe(msg('err.calendar.employeeNotOnLift'));
  });

  // guards: BR-WO-028, BR-WO-027
  it('відвʼязка запису наряду «В роботі» → 400 з причиною, дати наряду й запис цілі (Bug #907)', async () => {
    const h = planned({ wo: { status: 'IN_PROGRESS' } });

    const err = await rejected(
      h,
      h.service.updateCalendarSlot(ORG, 'anchor', { workOrderId: null }, USER),
    );
    expect(err.message).toBe(msg('err.calendar.workOrderRelinkLocked'));
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  // guards: BR-WO-028, BR-WO-027
  it('наряд став «В роботі» між перевіркою і транзакцією відвʼязки → 400 під блокуванням, нічого не змінено', async () => {
    const h = planned();
    h.prisma.$queryRaw.mockImplementationOnce(async () => {
      woOf(h).status = 'IN_PROGRESS';
      return [];
    });
    const before = structuredClone(h.calendarSlot.rows);

    const err = await h.service
      .updateCalendarSlot(ORG, 'anchor', { workOrderId: null, counterpartyId: CLIENT }, USER)
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err!.message).toBe(msg('err.calendar.workOrderRelinkLocked'));
    expect(h.calendarSlot.rows).toEqual(before);
    expect(woOf(h)).toMatchObject({ plannedAt: kyiv(D, '10:00'), dueDate: kyiv(D, '12:00') });
  });
});

describe('Новий запис календаря для наряду — запис наряду (BR-WO-028, Bug #905)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Тіло форми «+ Слот» з обраним нарядом. */
  const createForm = (workOrderId: string, over: Row = {}) =>
    ({
      workOrderId,
      liftId: LIFT_2,
      startAt: iso(D2, '13:00'),
      endAt: iso(D2, '15:00'),
      counterpartyId: CLIENT,
      notes: 'З форми',
      ...over,
    }) as never;

  // guards: BR-WO-028, BR-WO-020
  it('наряд із датами → другого запису немає: запис наряду на його датах отримав механіка й примітку форми', async () => {
    const h = planned();

    const res = await h.service.createCalendarSlot(
      ORG,
      createForm(WO_ID, { liftId: LIFT_1, employeeId: MECH_1 }),
      USER,
    );

    expect(h.liveSlots()).toEqual([
      expect.objectContaining({
        id: 'anchor',
        liftId: LIFT_1,
        employeeId: MECH_1,
        notes: 'З форми',
      }),
    ]);
    expect(t(slotOf(h, 'anchor').startAt)).toBe(t(kyiv(D, '10:00')));
    expect(res.slots.map(s => s.id)).toEqual(['anchor']);
    expect(woOf(h)).toMatchObject({ liftId: LIFT_1, plannedAt: kyiv(D, '10:00') });
  });

  // guards: BR-WO-028, BR-WO-019
  it('наряд без дат → час і підйомник запису стають його датами й підйомником, нормогодини — робочі години', async () => {
    const h = planned();

    const res = await h.service.createCalendarSlot(ORG, createForm(OTHER_WO), USER);

    expect(woOf(h, OTHER_WO)).toMatchObject({ liftId: LIFT_2, plannedHours: 2 });
    expect(t(woOf(h, OTHER_WO).plannedAt)).toBe(t(kyiv(D2, '13:00')));
    expect(t(woOf(h, OTHER_WO).dueDate)).toBe(t(kyiv(D2, '15:00')));
    expect(h.liveSlots(OTHER_WO)).toEqual([
      expect.objectContaining({ liftId: LIFT_2, notes: 'З форми', parentSlotId: null }),
    ]);
    expect(res.slots).toHaveLength(1);
    // Запис наряду WO_ID не чіпається.
    expect(h.liveSlots()).toEqual([expect.objectContaining({ id: 'anchor' })]);
  });

  // guards: BR-WO-028, BR-WO-020
  it('наряд без дат, запис за кінець робочого дня → два записи (до 18:00 і з 08:00), кінець наряду — наступного дня', async () => {
    const h = planned();

    const res = await h.service.createCalendarSlot(
      ORG,
      createForm(OTHER_WO, { startAt: iso(D2, '17:00'), endAt: iso(D2, '19:00') }),
      USER,
    );

    expect(t(woOf(h, OTHER_WO).dueDate)).toBe(t(kyiv('2026-05-24', '09:00')));
    expect(res.slots.map(s => [s.startAt, s.endAt])).toEqual([
      [iso(D2, '17:00'), iso(D2, '18:00')],
      [iso('2026-05-24', '08:00'), iso('2026-05-24', '09:00')],
    ]);
  });

  // guards: BR-WO-028, BR-WO-027
  it('наряд «В роботі» → 400 з причиною, жодного запису, наряд не змінено', async () => {
    const h = planned({ other: { status: 'IN_PROGRESS' } });

    const err = await rejected(h, h.service.createCalendarSlot(ORG, createForm(OTHER_WO)));
    expect(err.message).toBe(msg('err.calendar.workOrderSlotLocked'));
  });

  // guards: BR-WO-022
  it('скасований наряд → 400, жодного запису', async () => {
    const h = planned({ other: { status: 'CANCELLED' } });

    const err = await rejected(h, h.service.createCalendarSlot(ORG, createForm(OTHER_WO)));
    expect(err.message).toBe(msg('err.calendar.workOrderCancelled'));
  });

  // guards: BR-WO-028, BR-CAL-012
  it('механік не закріплений за підйомником запису → 400, наряд без дат лишається без дат', async () => {
    const h = planned();

    const err = await rejected(
      h,
      h.service.createCalendarSlot(ORG, createForm(OTHER_WO, { employeeId: MECH_1 })),
    );
    expect(err.message).toBe(msg('err.calendar.employeeNotOnLift'));
  });

  // guards: BR-WO-028, BR-CAL-005
  it('підйомник зайнятий на час форми → 400 «зайнятий», наряд без дат, записів не додано', async () => {
    const h = planned({
      extra: [
        slotRow('busy', {
          workOrderId: null,
          liftId: LIFT_2,
          startAt: kyiv(D2, '14:00'),
          endAt: kyiv(D2, '16:00'),
        }),
      ],
    });

    const err = await rejected(h, h.service.createCalendarSlot(ORG, createForm(OTHER_WO)));
    expect(err.message).toBe(msg('err.calendar.liftBusy'));
  });
});
