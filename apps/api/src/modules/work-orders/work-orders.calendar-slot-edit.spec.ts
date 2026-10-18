/**
 * BR-WO-024 — будь-яка зміна запису наряду в календарі йде через дати наряду (рішення власника
 * 2026-10-18). `PATCH /calendar/slots/:id` (зміна меж у «Дні», форма запису) змінює наряд: межі
 * ланцюжка запису після зміни стають плановими початком і завершенням, підйомник запису —
 * підйомником наряду. Перевірки — як у
 * збереженні наряду (BR-WO-019, BR-WO-020, механік — BR-CAL-012); відмова — 400, ні наряд, ні
 * записи не змінюються. Примітка й механік без зміни часу, записи без наряду — як раніше.
 *
 * Справжні WorkOrdersService + CalendarService над таблицями в пам'яті
 * (`work-orders.planning.spec-fixture.ts`; `$transaction` відкочує таблиці при винятку).
 * «Зараз» — 20.05.2026 09:00 Києва; філія 08:00–18:00.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import {
  LIFT_1,
  LIFT_2,
  MECH_1,
  MECH_BOTH,
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
const t = (d: unknown) => (d as Date).getTime();
const iso = (day: string, hhmm: string) => kyiv(day, hhmm).toISOString();

/** Наряд WO_ID (D 10:00–12:00 на LIFT_1) з якорем у календарі. */
function planned(
  woOver: Record<string, unknown> = {},
  slotOver: Record<string, unknown> = {},
  extra: Record<string, unknown>[] = [],
) {
  return planningHarness({
    workOrders: [
      woRow({ liftId: LIFT_1, plannedAt: kyiv(D, '10:00'), dueDate: kyiv(D, '12:00'), ...woOver }),
      woRow({ id: OTHER_WO, number: 'НРД-9', status: 'APPROVED' }),
    ],
    slots: [slotRow('anchor', slotOver), ...(extra as never[])],
  });
}

/** Наряд на два дні: D 16:00 → D2 10:00 (якір D 16–18, продовження D2 08–10). */
function twoDays() {
  return planningHarness({
    workOrders: [
      woRow({ liftId: LIFT_1, plannedAt: kyiv(D, '16:00'), dueDate: kyiv(D2, '10:00') }),
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

type Harness = ReturnType<typeof planningHarness>;
const wo = (h: Harness) => h.workOrder.rows.find(w => w.id === WO_ID)!;
const snapshot = (h: Harness) => structuredClone([h.workOrder.rows, h.calendarSlot.rows]);
const spans = (h: Harness) =>
  h
    .liveSlots()
    .sort((a, b) => t(a.startAt) - t(b.startAt))
    .map(s => [t(s.startAt), t(s.endAt)]);

async function rejected(h: Harness, p: Promise<unknown>, ErrorType = BadRequestException) {
  const before = snapshot(h);
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ErrorType);
  // Ні наряд, ні записи не змінились.
  expect(snapshot(h)).toEqual(before);
  return err as Error;
}

describe('PATCH /calendar/slots/:id для запису наряду — зміна меж (BR-WO-024)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-WO-024
  it('кінець запису 12:00 → 14:00 → завершення наряду 14:00, початок той самий, той самий запис', async () => {
    const h = planned();

    const res = await h.service.updateCalendarSlot(ORG, 'anchor', {
      startAt: iso(D, '10:00'),
      endAt: iso(D, '14:00'),
    });

    expect(t(wo(h).plannedAt)).toBe(t(kyiv(D, '10:00')));
    expect(t(wo(h).dueDate)).toBe(t(kyiv(D, '14:00')));
    expect(h.liveSlots().map(s => s.id)).toEqual(['anchor']);
    expect(spans(h)).toEqual([[t(kyiv(D, '10:00')), t(kyiv(D, '14:00'))]]);
    expect(res).toMatchObject({ id: 'anchor', workOrderId: WO_ID, endAt: iso(D, '14:00') });
  });

  // guards: BR-WO-024
  it('початок запису 10:00 → 09:00 → плановий початок 09:00, тривалість наряду більша', async () => {
    const h = planned();

    await h.service.updateCalendarSlot(ORG, 'anchor', { startAt: iso(D, '09:00') });

    expect(t(wo(h).plannedAt)).toBe(t(kyiv(D, '09:00')));
    expect(t(wo(h).dueDate)).toBe(t(kyiv(D, '12:00')));
  });

  // guards: BR-WO-024
  it('кінець продовження багатоденного 10:00 → 13:00 → завершення наряду D2 13:00, ланцюжок перебудовано', async () => {
    const h = twoDays();

    await h.service.updateCalendarSlot(ORG, 'cont', { endAt: iso(D2, '13:00') });

    expect(t(wo(h).plannedAt)).toBe(t(kyiv(D, '16:00')));
    expect(t(wo(h).dueDate)).toBe(t(kyiv(D2, '13:00')));
    expect(spans(h)).toEqual([
      [t(kyiv(D, '16:00')), t(kyiv(D, '18:00'))],
      [t(kyiv(D2, '08:00')), t(kyiv(D2, '13:00'))],
    ]);
    expect(h.liveSlots().find(s => s.parentSlotId === null)!.id).toBe('anchor');
  });

  // guards: BR-WO-024
  it('запис уже розійшовся з нарядом → дати наряду — межі запису після зміни', async () => {
    const h = planned({}, { startAt: kyiv(D, '14:00'), endAt: kyiv(D, '15:00') });

    await h.service.updateCalendarSlot(ORG, 'anchor', { endAt: iso(D, '16:00') });

    expect(t(wo(h).plannedAt)).toBe(t(kyiv(D, '14:00')));
    expect(t(wo(h).dueDate)).toBe(t(kyiv(D, '16:00')));
  });

  // guards: BR-WO-024
  it('запис розійшовся (10–11), кінець → 12:00 = дати наряду → запис знову на датах наряду', async () => {
    const h = planned({}, { startAt: kyiv(D, '10:00'), endAt: kyiv(D, '11:00') });

    await h.service.updateCalendarSlot(ORG, 'anchor', { endAt: iso(D, '12:00') });

    expect(t(wo(h).dueDate)).toBe(t(kyiv(D, '12:00')));
    expect(spans(h)).toEqual([[t(kyiv(D, '10:00')), t(kyiv(D, '12:00'))]]);
  });

  // guards: BR-WO-024
  it('поза робочими годинами філії → 400 з годинами, без змін', async () => {
    const h = planned();

    const err = await rejected(
      h,
      h.service.updateCalendarSlot(ORG, 'anchor', { startAt: iso(D, '07:00') }),
    );
    expect(err.message).toContain('08:00');
  });

  // guards: BR-WO-024
  it('у минуле → 400 «в минулому», без змін', async () => {
    const h = planned(
      { plannedAt: kyiv('2026-05-20', '10:00'), dueDate: kyiv('2026-05-20', '11:00') },
      { startAt: kyiv('2026-05-20', '10:00'), endAt: kyiv('2026-05-20', '11:00') },
    );

    const err = await rejected(
      h,
      h.service.updateCalendarSlot(ORG, 'anchor', { startAt: iso('2026-05-20', '08:00') }),
    );
    expect(err.message).toBe(translateError('err.workOrder.plannedInPast', 'uk'));
  });

  // guards: BR-WO-024
  it('новий кінець перетинає інший запис на підйомнику → 400 «зайнятий», без змін', async () => {
    const h = planned({}, {}, [
      slotRow('busy', {
        workOrderId: null,
        startAt: kyiv(D, '13:00'),
        endAt: kyiv(D, '14:00'),
      }),
    ]);

    const err = await rejected(
      h,
      h.service.updateCalendarSlot(ORG, 'anchor', { endAt: iso(D, '13:30') }),
    );
    expect(err.message).toBe(translateError('err.calendar.liftBusy', 'uk'));
  });

  // guards: BR-WO-024
  it('закритий наряд (виконаний) → 400, без змін', async () => {
    const h = planned({ status: 'COMPLETED' });

    await rejected(h, h.service.updateCalendarSlot(ORG, 'anchor', { endAt: iso(D, '13:00') }));
  });

  // guards: BR-WO-024
  it('запис чужої організації → 404, без змін', async () => {
    const h = planned({}, {}, [slotRow('foreign', { orgId: OTHER_ORG, liftId: LIFT_2 })]);

    await rejected(
      h,
      h.service.updateCalendarSlot(ORG, 'foreign', { endAt: iso(D, '13:00') }),
      NotFoundException,
    );
  });
});

describe('PATCH /calendar/slots/:id для запису наряду — форма запису (BR-WO-024)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-WO-024
  it('час, підйомник, механік і примітка з форми → дати й підйомник наряду, механік і примітка на записі', async () => {
    const h = planned();

    await h.service.updateCalendarSlot(ORG, 'anchor', {
      liftId: LIFT_2,
      employeeId: MECH_BOTH,
      startAt: iso(D, '13:00'),
      endAt: iso(D, '15:00'),
      notes: 'Клієнт чекає',
      workOrderId: WO_ID,
    });

    expect(wo(h)).toMatchObject({ liftId: LIFT_2 });
    expect(t(wo(h).plannedAt)).toBe(t(kyiv(D, '13:00')));
    expect(t(wo(h).dueDate)).toBe(t(kyiv(D, '15:00')));
    expect(h.liveSlots()).toEqual([
      expect.objectContaining({
        id: 'anchor',
        liftId: LIFT_2,
        employeeId: MECH_BOTH,
        notes: 'Клієнт чекає',
      }),
    ]);
  });

  // guards: BR-WO-024
  it('кінець за закриттям дня (форма шле «початок + тривалість») → залишок наступного дня від відкриття', async () => {
    const h = planned();

    await h.service.updateCalendarSlot(ORG, 'anchor', {
      startAt: iso(D, '17:00'),
      endAt: iso(D, '19:00'),
    });

    expect(t(wo(h).plannedAt)).toBe(t(kyiv(D, '17:00')));
    expect(t(wo(h).dueDate)).toBe(t(kyiv(D2, '09:00')));
    expect(spans(h)).toEqual([
      [t(kyiv(D, '17:00')), t(kyiv(D, '18:00'))],
      [t(kyiv(D2, '08:00')), t(kyiv(D2, '09:00'))],
    ]);
  });

  // guards: BR-WO-024
  it('механік, обраний у формі, не закріплений за новим підйомником → 400 (BR-CAL-012), без змін', async () => {
    const h = planned();

    const err = await rejected(
      h,
      h.service.updateCalendarSlot(ORG, 'anchor', {
        liftId: LIFT_2,
        employeeId: MECH_1,
        startAt: iso(D, '10:00'),
        endAt: iso(D, '12:00'),
      }),
    );
    expect(err.message).toBe(translateError('err.calendar.employeeNotOnLift', 'uk'));
  });

  // guards: BR-WO-024
  it('збережений механік не закріплений за новим підйомником → 400 у формі, а не зняття', async () => {
    const h = planned({}, { employeeId: MECH_1 });

    await rejected(
      h,
      h.service.updateCalendarSlot(ORG, 'anchor', { liftId: LIFT_2, employeeId: MECH_1 }),
    );
  });

  // guards: BR-WO-024
  it('`dropMechanicNotOnLift` — свого механіка знято з причиною, наряд на новому підйомнику', async () => {
    const h = planned({}, { employeeId: MECH_1 });

    const res = await h.service.updateCalendarSlot(ORG, 'anchor', {
      liftId: LIFT_2,
      dropMechanicNotOnLift: true,
    });

    expect(res).toMatchObject({ mechanicDropped: true, mechanicDroppedReason: 'NOT_ON_LIFT' });
    expect(wo(h).liftId).toBe(LIFT_2);
    expect(h.liveSlots()[0]).toMatchObject({ liftId: LIFT_2, employeeId: null });
  });

  // guards: BR-WO-024
  it('той самий час і підйомник, змінено лише примітку → запис сам, наряд не чіпається', async () => {
    const h = planned();
    const before = structuredClone(wo(h));

    await h.service.updateCalendarSlot(ORG, 'anchor', {
      liftId: LIFT_1,
      startAt: iso(D, '10:00'),
      endAt: iso(D, '12:00'),
      notes: 'Лише примітка',
    });

    expect(wo(h)).toEqual(before);
    expect(h.liveSlots()[0]).toMatchObject({ notes: 'Лише примітка' });
  });

  // guards: BR-WO-024 — Bug #902: якорю з продовженням `CalendarService.updateSlot` відмовляв
  // («редагуйте кожен окремо»), хоча час того ж запису форма змінює.
  it('багатоденний: лише механік і примітка на якорі → для всього ланцюжка, дати наряду ті самі', async () => {
    const h = twoDays();
    const before = structuredClone(wo(h));

    await h.service.updateCalendarSlot(ORG, 'anchor', {
      liftId: LIFT_1,
      employeeId: MECH_BOTH,
      startAt: iso(D, '16:00'),
      endAt: iso(D, '18:00'),
      notes: 'Два дні',
      workOrderId: WO_ID,
    });

    expect(wo(h)).toMatchObject({
      plannedAt: before.plannedAt,
      dueDate: before.dueDate,
      liftId: LIFT_1,
    });
    expect(spans(h)).toEqual([
      [t(kyiv(D, '16:00')), t(kyiv(D, '18:00'))],
      [t(kyiv(D2, '08:00')), t(kyiv(D2, '10:00'))],
    ]);
    expect(h.liveSlots().map(s => [s.employeeId, s.notes])).toEqual([
      [MECH_BOTH, 'Два дні'],
      [MECH_BOTH, 'Два дні'],
    ]);
  });

  // guards: BR-WO-024 — Bug #902: примітка лише на продовженні губилась при перебудові ланцюжка.
  it('багатоденний: примітка на продовженні → на всьому ланцюжку (якір її теж має)', async () => {
    const h = twoDays();

    await h.service.updateCalendarSlot(ORG, 'cont', { notes: 'З продовження' });

    expect(h.liveSlots().map(s => s.notes)).toEqual(['З продовження', 'З продовження']);
    expect(h.liveSlots().find(s => s.parentSlotId === null)!.id).toBe('anchor');
  });

  // guards: BR-WO-024 — Bug #902: перевірка механіка (BR-CAL-012) і на шляху ланцюжка.
  it('багатоденний: механік не закріплений за підйомником ланцюжка → 400, без змін', async () => {
    const h = planningHarness({
      workOrders: [
        woRow({ liftId: LIFT_2, plannedAt: kyiv(D, '16:00'), dueDate: kyiv(D2, '10:00') }),
      ],
      slots: [
        slotRow('anchor', { liftId: LIFT_2, startAt: kyiv(D, '16:00'), endAt: kyiv(D, '18:00') }),
        slotRow('cont', {
          liftId: LIFT_2,
          parentSlotId: 'anchor',
          startAt: kyiv(D2, '08:00'),
          endAt: kyiv(D2, '10:00'),
        }),
      ],
    });

    const err = await rejected(
      h,
      h.service.updateCalendarSlot(ORG, 'anchor', { employeeId: MECH_1 }),
    );
    expect(err.message).toBe(translateError('err.calendar.employeeNotOnLift', 'uk'));
  });

  // guards: BR-WO-024 — Bug #903: нова тривалість — нові планові нормогодини, як у картці.
  it('кінець запису 12:00 → 14:00 → «Нормогодин» наряду 2 → 4; перенесення без зміни тривалості — без змін', async () => {
    const h = planned({ plannedHours: 2 });

    await h.service.updateCalendarSlot(ORG, 'anchor', { endAt: iso(D, '14:00') });
    expect(wo(h).plannedHours).toBe(4);

    await h.service.updateCalendarSlot(ORG, 'anchor', {
      startAt: iso(D, '15:00'),
      endAt: iso(D, '17:00'),
    });
    expect(wo(h).plannedHours).toBe(2);

    await h.service.updateCalendarSlot(ORG, 'anchor', {
      startAt: iso(D, '16:00'),
      endAt: iso(D, '18:00'),
    });
    expect(wo(h).plannedHours).toBe(2);
  });

  // guards: BR-WO-024 — Bug #903: нормогодини — робочі години між датами, а не доба.
  it('кінець за закриттям дня (17:00 + 2 год) → «Нормогодин» 2, а не 16', async () => {
    const h = planned({ plannedHours: 2 });

    await h.service.updateCalendarSlot(ORG, 'anchor', {
      startAt: iso(D, '17:00'),
      endAt: iso(D, '19:00'),
    });

    expect(t(wo(h).dueDate)).toBe(t(kyiv(D2, '09:00')));
    expect(wo(h).plannedHours).toBe(2);
  });

  // guards: BR-WO-024
  it('запис без наряду → змінюється сам, як раніше', async () => {
    const h = planned({}, {}, [
      slotRow('plain', {
        workOrderId: null,
        liftId: LIFT_2,
        startAt: kyiv(D, '13:00'),
        endAt: kyiv(D, '14:00'),
      }),
    ]);
    const before = structuredClone(wo(h));

    await h.service.updateCalendarSlot(ORG, 'plain', { endAt: iso(D, '15:00') });

    expect(wo(h)).toEqual(before);
    const plain = h.calendarSlot.rows.find(r => r.id === 'plain')!;
    expect(t(plain.endAt)).toBe(t(kyiv(D, '15:00')));
  });
});
