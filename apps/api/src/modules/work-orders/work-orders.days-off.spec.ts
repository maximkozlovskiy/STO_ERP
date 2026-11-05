/**
 * Вихідні філії в планових датах наряду й розбитті запису по днях (рішення власника 2026-10-30,
 * TECH-DEBT (б) №65 / (а) §13 п. 21). Робочі дні філії — `BranchSettings.workDays` (ISO 1 = пн …
 * 7 = нд). Змінена планова дата на вихідному — 400 `err.workOrder.plannedOnDayOff`; запис
 * календаря наряду й нормогодини між датами вихідних не рахують; переповнення запису переходить
 * на наступний робочий день.
 *
 * Правила — docs/objects/work-order.md BR-WO-019, docs/objects/calendar.md BR-CAL-016.
 * Дати: 22.05.2026 — пт, 23.05 — сб, 24.05 — нд, 25.05 — пн (травень, +03:00).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { plannedDatesError } from './work-order-planned-dates';
import { overflowEnd, workHoursBetween } from './work-order-slot-move';
import {
  LIFT_1,
  NOW,
  ORG,
  WO_ID,
  createDto,
  kyiv,
  planningHarness,
  slotRow,
  woRow,
} from './work-orders.planning.spec-fixture';

const SAT = '2026-05-23';
const SUN = '2026-05-24';
const MON = '2026-05-25';
const MON_SAT = [1, 2, 3, 4, 5, 6];
const H = { startHour: 8, endHour: 18, workDays: MON_SAT };
const DAY_OFF = translateError('err.workOrder.plannedOnDayOff', 'uk');

const t = (d: unknown) => (d as Date).getTime();
const next = (plannedAt: Date | null, dueDate: Date | null) => ({ plannedAt, dueDate });

type Harness = ReturnType<typeof planningHarness>;
const wo = (h: Harness) => h.workOrder.rows.find(w => w.id === WO_ID)!;
const spans = (h: Harness, workOrderId = WO_ID) =>
  h
    .liveSlots(workOrderId)
    .sort((a, b) => t(a.startAt) - t(b.startAt))
    .map(s => [t(s.startAt), t(s.endAt)]);

describe('plannedDatesError — вихідні філії (BR-WO-019)', () => {
  // guards: BR-WO-019
  it.each([
    ['початок у неділю', next(kyiv(SUN, '10:00'), null)],
    ['завершення в неділю', next(kyiv(SAT, '10:00'), kyiv(SUN, '10:00'))],
    ['неділя ще й поза годинами — причина «вихідний»', next(kyiv(SUN, '20:00'), null)],
  ])('%s → «вихідний день філії»', (_l, n) => {
    expect(plannedDatesError(n, null, NOW, H)).toEqual({ key: 'err.workOrder.plannedOnDayOff' });
  });

  // guards: BR-WO-019
  it('субота й понеділок пн–сб — робочі: без помилки', () => {
    expect(
      plannedDatesError(next(kyiv(SAT, '17:00'), kyiv(MON, '11:00')), null, NOW, H),
    ).toBeNull();
  });

  // guards: BR-WO-019
  it('незмінені старі дати на вихідному не перевіряються', () => {
    const prev = next(kyiv(SUN, '10:00'), kyiv(SUN, '12:00'));
    expect(plannedDatesError(prev, prev, NOW, H)).toBeNull();
    // Змінено лише завершення (на робочий пн) — стара неділя-початок не заважає.
    expect(plannedDatesError(next(prev.plannedAt, kyiv(MON, '09:00')), prev, NOW, H)).toBeNull();
  });

  // guards: BR-WO-019
  it('переліку днів немає чи він порожній → неділя робоча', () => {
    const sunday = next(kyiv(SUN, '10:00'), kyiv(SUN, '12:00'));
    expect(plannedDatesError(sunday, null, NOW, { startHour: 8, endHour: 18 })).toBeNull();
    expect(plannedDatesError(sunday, null, NOW, { ...H, workDays: [] })).toBeNull();
  });

  // guards: BR-WO-019
  it('завершення о 24:00 суботи (00:00 неділі) належить суботі, а не вихідній неділі', () => {
    const allDay = { startHour: 0, endHour: 24, workDays: MON_SAT };
    expect(
      plannedDatesError(next(kyiv(SAT, '20:00'), kyiv(SUN, '00:00')), null, NOW, allDay),
    ).toBeNull();
    expect(plannedDatesError(next(kyiv(SUN, '00:00'), null), null, NOW, allDay)).toEqual({
      key: 'err.workOrder.plannedOnDayOff',
    });
  });
});

describe('overflowEnd / workHoursBetween — вихідні пропускаються (BR-CAL-016, BR-WO-019)', () => {
  // guards: BR-CAL-016
  it('сб 17:00 + 2 год (вікно 8–18, пн–сб) → кінець у пн 09:00, не в нд', () => {
    expect(t(overflowEnd(kyiv(SAT, '17:00'), kyiv(SAT, '19:00'), H))).toBe(t(kyiv(MON, '09:00')));
    // Без переліку днів — як раніше, наступного календарного дня.
    expect(
      t(overflowEnd(kyiv(SAT, '17:00'), kyiv(SAT, '19:00'), { startHour: 8, endHour: 18 })),
    ).toBe(t(kyiv(SUN, '09:00')));
  });

  // guards: BR-WO-019
  it('нормогодини сб 17:00 → пн 10:00: 1 + 2 = 3 год без неділі (з неділею — 13)', () => {
    expect(workHoursBetween(kyiv(SAT, '17:00'), kyiv(MON, '10:00'), H)).toBe(3);
    expect(
      workHoursBetween(kyiv(SAT, '17:00'), kyiv(MON, '10:00'), { startHour: 8, endHour: 18 }),
    ).toBe(13);
  });
});

describe('WorkOrdersService — вихідні філії при збереженні наряду (BR-WO-019, BR-WO-020)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-WO-019
  it('create з початком у неділю (філія пн–сб) → 400 «вихідний день філії», наряд не створено', async () => {
    const h = planningHarness({ workOrders: [], workDays: MON_SAT });
    const err = await h.service
      .create(
        ORG,
        createDto({
          liftId: LIFT_1,
          plannedAt: kyiv(SUN, '10:00').toISOString(),
          dueDate: kyiv(MON, '10:00').toISOString(),
        }),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe(DAY_OFF);
    expect((err as Error).message).toBe('Плановий час припадає на вихідний день філії');
    expect(h.workOrder.rows).toHaveLength(0);
    expect(h.docNumbers.next).not.toHaveBeenCalled();
  });

  // guards: BR-CAL-016
  it('create сб 17:00 → пн 11:00 (пн–сб) → записи сб 17–18 і пн 08–11, неділі немає', async () => {
    const h = planningHarness({ workOrders: [], workDays: MON_SAT });
    const created = (await h.service.create(
      ORG,
      createDto({
        liftId: LIFT_1,
        plannedAt: kyiv(SAT, '17:00').toISOString(),
        dueDate: kyiv(MON, '11:00').toISOString(),
      }),
    )) as { id: string };
    expect(spans(h, created.id)).toEqual([
      [t(kyiv(SAT, '17:00')), t(kyiv(SAT, '18:00'))],
      [t(kyiv(MON, '08:00')), t(kyiv(MON, '11:00'))],
    ]);
  });

  // guards: BR-WO-019
  it('update старого наряду з датами на неділі, що форма шле без змін, → зберігається', async () => {
    const plannedAt = kyiv(SUN, '10:00');
    const dueDate = kyiv(SUN, '12:00');
    const h = planningHarness({ workOrders: [woRow({ plannedAt, dueDate })], workDays: MON_SAT });
    await h.service.update(ORG, WO_ID, {
      description: 'новий опис',
      plannedAt: plannedAt.toISOString(),
      dueDate: dueDate.toISOString(),
    });
    expect(wo(h).description).toBe('новий опис');
    expect(t(wo(h).plannedAt)).toBe(t(plannedAt));
  });

  // guards: BR-CAL-016
  it('форма запису: сб 17:00 + 2 год → завершення наряду пн 09:00, записи сб і пн', async () => {
    const h = planningHarness({
      workOrders: [
        woRow({ liftId: LIFT_1, plannedAt: kyiv(SAT, '10:00'), dueDate: kyiv(SAT, '12:00') }),
      ],
      slots: [slotRow('anchor', { startAt: kyiv(SAT, '10:00'), endAt: kyiv(SAT, '12:00') })],
      workDays: MON_SAT,
    });
    await h.service.updateCalendarSlot(ORG, 'anchor', {
      startAt: kyiv(SAT, '17:00').toISOString(),
      endAt: kyiv(SAT, '19:00').toISOString(),
    });
    expect(t(wo(h).plannedAt)).toBe(t(kyiv(SAT, '17:00')));
    expect(t(wo(h).dueDate)).toBe(t(kyiv(MON, '09:00')));
    expect(spans(h)).toEqual([
      [t(kyiv(SAT, '17:00')), t(kyiv(SAT, '18:00'))],
      [t(kyiv(MON, '08:00')), t(kyiv(MON, '09:00'))],
    ]);
  });
});
