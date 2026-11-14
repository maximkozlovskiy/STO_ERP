/**
 * BR-WO-024 (рішення власника 2026-11-14, TECH-DEBT (б) №97) — розпочатий ланцюжок наряду не
 * переноситься: запис наряду, чий початок (початок першої частини) уже минув, не зсувається ні
 * перетягуванням (`reschedule`), ні ручкою чи формою запису (`PATCH /calendar/slots/:id`) — 400
 * `err.calendar.chainStarted`, ні наряд, ні записи не змінюються. Кінець останнього дня
 * змінюється (нові планові завершення й нормогодини), перенесення на інший підйомник без зсуву —
 * теж.
 *
 * Справжні WorkOrdersService + CalendarService над таблицями в пам'яті
 * (`work-orders.planning.spec-fixture.ts`). «Зараз» — 20.05.2026 09:00 Києва; філія 08:00–18:00
 * щодня. Ланцюжок наряду: 20.05 08:00–18:00 і 21.05 08:00–12:00 на LIFT_1.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import {
  LIFT_1,
  LIFT_2,
  NOW,
  ORG,
  WO_ID,
  kyiv,
  planningHarness,
  slotRow,
  woRow,
} from './work-orders.planning.spec-fixture';

const D = '2026-05-20';
const D2 = '2026-05-21';
const iso = (d: string, hm: string) => kyiv(d, hm).toISOString();
const t = (d: unknown) => (d as Date).getTime();
const STARTED = translateError('err.calendar.chainStarted', 'uk');

type Harness = ReturnType<typeof planningHarness>;
const wo = (h: Harness) => h.workOrder.rows.find(w => w.id === WO_ID)!;

/** Наряд на два дні, що почався о 08:00 (зараз 09:00). */
function started() {
  return planningHarness({
    workOrders: [
      woRow({
        status: 'APPROVED',
        liftId: LIFT_1,
        plannedAt: kyiv(D, '08:00'),
        dueDate: kyiv(D2, '12:00'),
        plannedHours: 14,
      }),
    ],
    slots: [
      slotRow('anchor', { startAt: kyiv(D, '08:00'), endAt: kyiv(D, '18:00') }),
      slotRow('cont', {
        parentSlotId: 'anchor',
        startAt: kyiv(D2, '08:00'),
        endAt: kyiv(D2, '12:00'),
      }),
    ],
  });
}

async function rejected(h: Harness, p: Promise<unknown>): Promise<Error> {
  const before = structuredClone([h.workOrder.rows, h.calendarSlot.rows]);
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(BadRequestException);
  expect(structuredClone([h.workOrder.rows, h.calendarSlot.rows])).toEqual(before);
  return e as Error;
}

describe('BR-WO-024 — розпочатий ланцюжок наряду (№97)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-WO-024
  it.each([
    ['перетягування якоря на годину пізніше', 'anchor', iso(D, '09:00')],
    ['перетягування продовження на день пізніше', 'cont', iso('2026-05-22', '08:00')],
  ])('%s → 400 chainStarted, без змін', async (_l, slotId, startAt) => {
    const h = started();

    const e = await rejected(h, h.service.reschedule(ORG, WO_ID, { slotId, startAt }));

    expect(e.message).toBe(STARTED);
  });

  // guards: BR-WO-024
  it('перенесення на інший підйомник без зсуву — дозволене', async () => {
    const h = started();

    await h.service.reschedule(ORG, WO_ID, {
      slotId: 'anchor',
      startAt: iso(D, '08:00'),
      liftId: LIFT_2,
    });

    expect(wo(h).liftId).toBe(LIFT_2);
    expect(t(wo(h).plannedAt)).toBe(t(kyiv(D, '08:00')));
  });

  // guards: BR-WO-024
  it('ручка початку першого дня → 400 chainStarted, без змін', async () => {
    const h = started();

    const e = await rejected(
      h,
      h.service.updateCalendarSlot(ORG, 'anchor', { startAt: iso(D, '10:00') }),
    );

    expect(e.message).toBe(STARTED);
  });

  // guards: BR-WO-024
  it('кінець останнього дня — змінюється: нове завершення й нормогодини наряду', async () => {
    const h = started();

    await h.service.updateCalendarSlot(ORG, 'cont', {
      startAt: iso(D2, '08:00'),
      endAt: iso(D2, '14:00'),
    });

    expect(t(wo(h).plannedAt)).toBe(t(kyiv(D, '08:00')));
    expect(t(wo(h).dueDate)).toBe(t(kyiv(D2, '14:00')));
    expect(wo(h).plannedHours).toBe(16);
  });

  // guards: BR-WO-024
  it('ланцюжок, що ще не почався, — переноситься, як раніше', async () => {
    vi.setSystemTime(kyiv(D, '07:59'));
    const h = started();

    await h.service.reschedule(ORG, WO_ID, { slotId: 'anchor', startAt: iso(D, '09:00') });

    expect(t(wo(h).plannedAt)).toBe(t(kyiv(D, '09:00')));
  });
});
