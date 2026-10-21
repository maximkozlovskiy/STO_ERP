/**
 * Запис наряду в календарі: перев'язка на інший наряд, відв'язка й новий запис для наряду
 * (рішення власника 2026-10-18, 2026-10-19; винесено з `work-orders.calendar-slot-lifecycle.spec.ts`).
 *
 * - BR-WO-028: перев'язка запису на інший наряд ставить запис на дати й підйомник нового наряду
 *   (або дає йому свої); попередній наряд утрачає запис і дати. Обидва наряди — редаговані. Свій
 *   механік запису, не закріплений за підйомником нового наряду, знімається з причиною; обраний у
 *   формі явно — 400. Відв'язка («×») — втрата запису нарядом, як BR-WO-026 (Bug #906, #907).
 *   Новий запис для наряду — запис наряду (Bug #905).
 * - BR-CAL-003: службовий запис (обслуговування, перерва, нарада) не стає записом наряду і не
 *   отримує клієнта чи авто — ні новим записом із нарядом, ні зміною, ні перев'язкою (планшет іде
 *   тим самим `updateCalendarSlot`).
 *
 * Справжні WorkOrdersService + CalendarService над таблицями в пам'яті
 * (`work-orders.planning.spec-fixture.ts`; `$transaction` відкочує таблиці при винятку).
 * «Зараз» — 20.05.2026 09:00 Києва; філія 08:00–18:00.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import {
  CLIENT,
  LIFT_1,
  LIFT_2,
  MECH_1,
  MECH_BOTH,
  NOW,
  ORG,
  OTHER_WO,
  VEHICLE,
  WO_ID,
  kyiv,
  slotRow,
} from './work-orders.planning.spec-fixture';
import {
  D,
  D2,
  USER,
  t,
  iso,
  planned,
  twoDays,
  woOf,
  slotOf,
  rejected,
  msg,
  type Row,
} from './work-orders.calendar-slot-records.spec-fixture';

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

  // Рішення власника 2026-10-19: свій механік запису, не закріплений за підйомником нового наряду,
  // знімається з причиною у відповіді (як перетягування), а не дає 400.
  // guards: BR-WO-028, BR-CAL-012
  it('механік запису не закріплений за підйомником нового наряду → перев’язано, механіка знято з причиною', async () => {
    const h = planned({
      anchor: { employeeId: MECH_1 },
      other: { liftId: LIFT_2, plannedAt: kyiv(D2, '13:00'), dueDate: kyiv(D2, '15:00') },
    });

    // Форма шле збереженого механіка щоразу — це «свій» механік запису, не новий вибір.
    const res = await h.service.updateCalendarSlot(
      ORG,
      'anchor',
      relinkForm(OTHER_WO, { employeeId: MECH_1 }),
      USER,
    );

    expect(res).toMatchObject({
      id: 'anchor',
      workOrderId: OTHER_WO,
      mechanicDropped: true,
      mechanicDroppedReason: 'NOT_ON_LIFT',
    });
    expect(h.liveSlots(OTHER_WO)).toEqual([
      expect.objectContaining({ id: 'anchor', liftId: LIFT_2, employeeId: null }),
    ]);
    expect(woOf(h)).toMatchObject({ plannedAt: null, dueDate: null });
  });

  // guards: BR-WO-028, BR-CAL-012
  it('механік, закріплений і за підйомником нового наряду, лишається; mechanicDropped немає', async () => {
    const h = planned({
      anchor: { employeeId: MECH_BOTH },
      other: { liftId: LIFT_2, plannedAt: kyiv(D2, '13:00'), dueDate: kyiv(D2, '15:00') },
    });

    const res = await h.service.updateCalendarSlot(ORG, 'anchor', { workOrderId: OTHER_WO }, USER);

    expect(res).not.toHaveProperty('mechanicDropped');
    expect(slotOf(h, 'anchor')).toMatchObject({ liftId: LIFT_2, employeeId: MECH_BOTH });
  });

  // BR-WO-024: явний вибір незакріпленого механіка у формі — 400; разом із перев'язкою — так само.
  // guards: BR-WO-028, BR-CAL-012
  it('механік, обраний у формі разом із перевʼязкою, не закріплений за підйомником нового наряду → 400, нічого не змінено', async () => {
    const h = planned({
      anchor: { employeeId: MECH_BOTH },
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
    // Bug #909: у формі — П1, за яким механік закріплений; відповідь називає підйомник наряду.
    expect(err.message).toBe(
      translateError('err.calendar.employeeNotOnWorkOrderLift', 'uk', { lift: 'П2' }),
    );
  });

  // guards: BR-WO-028, BR-CAL-012
  it('механік, обраний разом із перевʼязкою на наряд із датами без підйомника → 400 «наряд без підйомника» (Bug #909)', async () => {
    const h = planned({
      anchor: { employeeId: MECH_BOTH },
      other: { liftId: null, plannedAt: kyiv(D2, '13:00'), dueDate: kyiv(D2, '15:00') },
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
    expect(err.message).toBe(msg('err.calendar.employeeWorkOrderNoLift'));
  });

  // Наряд без дат бере підйомник із форми — зміна підйомника є вибором користувача (BR-WO-024).
  // guards: BR-WO-028, BR-CAL-012
  it('новий наряд без дат, у формі інший підйомник, свій механік на ньому не закріплений → 400', async () => {
    const h = planned({ anchor: { employeeId: MECH_1 } });

    const err = await rejected(
      h,
      h.service.updateCalendarSlot(
        ORG,
        'anchor',
        relinkForm(OTHER_WO, { employeeId: MECH_1, liftId: LIFT_2 }),
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

  // guards: BR-WO-028, BR-CAL-012
  it('наряд із датами на іншому підйомнику, механік форми не закріплений за ним → 400 з назвою підйомника наряду (Bug #909)', async () => {
    const h = planned({
      other: { liftId: LIFT_2, plannedAt: kyiv(D2, '13:00'), dueDate: kyiv(D2, '15:00') },
    });

    const err = await rejected(
      h,
      h.service.createCalendarSlot(
        ORG,
        createForm(OTHER_WO, { liftId: LIFT_1, employeeId: MECH_1 }),
      ),
    );
    expect(err.message).toBe(
      translateError('err.calendar.employeeNotOnWorkOrderLift', 'uk', { lift: 'П2' }),
    );
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

describe('Службовий запис — без наряду, клієнта й авто (BR-CAL-003)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Перерва `svc` на LIFT_2 (D 14:00–15:00) поруч із записом наряду WO_ID. */
  const withBreak = () =>
    planned({
      extra: [
        slotRow('svc', {
          type: 'BREAK',
          workOrderId: null,
          liftId: LIFT_2,
          startAt: kyiv(D, '14:00'),
          endAt: kyiv(D, '15:00'),
          notes: 'Обід',
        }),
      ],
    });

  // guards: BR-CAL-003
  it.each(['MAINTENANCE', 'BREAK', 'MEETING'] as const)(
    'новий запис type=%s з нарядом → 400, жодного запису, наряд не змінено',
    async type => {
      const h = planned();

      const err = await rejected(
        h,
        h.service.createCalendarSlot(
          ORG,
          {
            type,
            workOrderId: OTHER_WO,
            liftId: LIFT_2,
            startAt: iso(D2, '13:00'),
            endAt: iso(D2, '15:00'),
          },
          USER,
        ),
      );
      expect(err.message).toBe(msg('err.calendar.serviceSlotNoClient'));
    },
  );

  // guards: BR-CAL-003
  it.each([
    ["перев'язка на наряд", { workOrderId: OTHER_WO }],
    ['клієнт', { counterpartyId: CLIENT }],
    ['автомобіль', { vehicleId: VEHICLE }],
  ])('зміна перерви: %s → 400, запис і наряди не змінено', async (_l, change) => {
    const h = withBreak();

    const err = await rejected(h, h.service.updateCalendarSlot(ORG, 'svc', change, USER));
    expect(err.message).toBe(msg('err.calendar.serviceSlotNoClient'));
  });

  // guards: BR-CAL-003
  it('зміна перерви з формою (наряд null, без клієнта) → час і примітка змінено, тип той самий', async () => {
    const h = withBreak();

    await h.service.updateCalendarSlot(
      ORG,
      'svc',
      {
        workOrderId: null,
        liftId: LIFT_2,
        startAt: iso(D, '15:00'),
        endAt: iso(D, '16:00'),
        notes: 'Обід пізніше',
      },
      USER,
    );

    expect(slotOf(h, 'svc')).toMatchObject({
      type: 'BREAK',
      workOrderId: null,
      counterpartyId: null,
      notes: 'Обід пізніше',
    });
    expect(t(slotOf(h, 'svc').startAt)).toBe(t(kyiv(D, '15:00')));
  });
});
