/**
 * Запис наряду в календарі: видалення і статус наряду (рішення власника 2026-10-18, 2026-10-19).
 * Перев'язка, відв'язка й новий запис для наряду — `work-orders.calendar-slot-relink.spec.ts`.
 *
 * - BR-WO-026: видалення запису наряду (`DELETE /calendar/slots/:id`) позначає видаленим увесь
 *   ланцюжок записів наряду і стирає планові дати наряду (нормогодини, виведені з дат, — теж);
 *   журнал змін наряду фіксує стерті дати.
 * - BR-WO-027: час і підйомник запису наряду змінюються лише в статусах, де картка змінює дати
 *   (`WO_EDITABLE_STATUSES`); інакше 400 з причиною. Примітка й механік — як раніше. Видалення
 *   запису наряду — лише в тих самих статусах (рішення власника 2026-10-19).
 *
 * Справжні WorkOrdersService + CalendarService над таблицями в пам'яті
 * (`work-orders.planning.spec-fixture.ts`; `$transaction` відкочує таблиці при винятку).
 * «Зараз» — 20.05.2026 09:00 Києва; філія 08:00–18:00.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  CLIENT,
  LIFT_1,
  LIFT_2,
  MECH_1,
  NOW,
  ORG,
  OTHER_ORG,
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
} from './work-orders.calendar-slot-records.spec-fixture';

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

  // Рішення власника 2026-10-19: видалення — лише там, де картка змінює дати (WO_EDITABLE_STATUSES).
  // guards: BR-WO-026
  it.each(['IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'INVOICED', 'PAID'])(
    'наряд %s → 400 з причиною, ланцюжок і дати наряду цілі, журнал не пишеться',
    async status => {
      const h = twoDays({ status });

      const err = await rejected(h, h.service.removeCalendarSlot(ORG, 'cont', USER));

      expect(err.message).toBe(msg('err.calendar.workOrderSlotDeleteLocked'));
      expect(h.liveSlots().map(s => s.id)).toEqual(['anchor', 'cont']);
      expect(h.audit.record).not.toHaveBeenCalled();
    },
  );

  // guards: BR-WO-026
  it.each(['ESTIMATE', 'APPROVED'])(
    'контроль: наряд %s → запис видалено, дати стерто',
    async status => {
      const h = planned({ wo: { status } });

      await h.service.removeCalendarSlot(ORG, 'anchor', USER);

      expect(h.liveSlots()).toEqual([]);
      expect(woOf(h)).toMatchObject({ plannedAt: null, dueDate: null });
    },
  );

  // guards: BR-WO-026
  it('наряд став «В роботі» між перевіркою і транзакцією видалення → 400 під блокуванням, нічого не змінено', async () => {
    const h = planned();
    // Перехід наряду в мить блокування — після перевірки статусу до транзакції.
    h.prisma.$queryRaw.mockImplementationOnce(async () => {
      woOf(h).status = 'IN_PROGRESS';
      return [];
    });
    const before = structuredClone(h.calendarSlot.rows);

    const err = await h.service.removeCalendarSlot(ORG, 'anchor', USER).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err!.message).toBe(msg('err.calendar.workOrderSlotDeleteLocked'));
    expect(h.calendarSlot.rows).toEqual(before);
    expect(t(woOf(h).plannedAt)).toBe(t(kyiv(D, '10:00')));
    expect(h.prisma.$queryRaw).toHaveBeenCalledWith(expect.anything(), ORG, [WO_ID]);
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
