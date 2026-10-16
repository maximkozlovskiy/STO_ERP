// Вид «День» (BR-CAL-011), чисті функції: категорія блоку з кінцем ланцюжка, лінія «зараз» і
// приглушене минуле за Києвом, завантаження підйомника з обрізанням по робочих годинах.

import { describe, expect, it } from 'vitest';
import { daySlotCategory, liftLoadHours, nowLinePercent, pastPercent } from '../calendar-day';
import { chainEnds } from '../calendar-month';
import type { CalendarSlot } from '../calendar.types';

const at = (local: string, offset = '+03:00') => new Date(`${local}:00${offset}`).getTime();
const iso = (local: string, offset = '+03:00') => new Date(at(local, offset)).toISOString();

const NOW = at('2026-10-15T12:00');
const DAY = '2026-10-15';

const slot = (
  id: string,
  start: string,
  end: string,
  extra: Partial<CalendarSlot> = {},
): CalendarSlot => ({
  id,
  liftId: 'L1',
  startAt: iso(start),
  endAt: iso(end),
  workOrderStatus: 'APPROVED',
  ...extra,
});

describe('daySlotCategory — колір блоку за станом (BR-CAL-011)', () => {
  const ends = new Map<string, number>();

  // guards: BR-CAL-011
  it.each([
    ['DRAFT', 'draft'],
    ['ESTIMATE', 'planned'],
    ['APPROVED', 'planned'],
    ['IN_PROGRESS', 'inProgress'],
    ['ON_HOLD', 'inProgress'],
    ['COMPLETED', 'done'],
    ['INVOICED', 'done'],
    ['PAID', 'done'],
    ['ARCHIVED', 'done'],
    ['CANCELLED', 'cancelled'],
    [null, 'other'],
  ])('майбутній запис зі статусом наряду %s → %s', (status, category) => {
    const s = slot('a', '2026-10-15T14:00', '2026-10-15T15:00', { workOrderStatus: status });
    expect(daySlotCategory(s, ends, NOW)).toBe(category);
  });

  // guards: BR-CAL-011
  it('закінчений запис з незавершеним нарядом — «прострочено», із завершеним — ні', () => {
    const open = slot('a', '2026-10-15T08:00', '2026-10-15T10:00', {
      workOrderStatus: 'IN_PROGRESS',
    });
    const paid = slot('b', '2026-10-15T08:00', '2026-10-15T10:00', { workOrderStatus: 'PAID' });
    expect(daySlotCategory(open, ends, NOW)).toBe('overdue');
    expect(daySlotCategory(paid, ends, NOW)).toBe('done');
  });

  // guards: BR-CAL-011
  it('прострочення — за кінцем ЛАНЦЮЖКА: частина з продовженням завтра не прострочена', () => {
    const part = slot('p', '2026-10-15T08:00', '2026-10-15T10:00');
    const cont = slot('c', '2026-10-16T08:00', '2026-10-16T11:00', { parentSlotId: 'p' });
    expect(daySlotCategory(part, chainEnds([part, cont]), NOW)).toBe('planned');
    // Без продовження в мапі — та сама частина прострочена.
    expect(daySlotCategory(part, chainEnds([part]), NOW)).toBe('overdue');
  });

  it('до гідратації (nowMs = 0) «прострочено» не ставиться', () => {
    const s = slot('a', '2026-10-15T08:00', '2026-10-15T10:00');
    expect(daySlotCategory(s, ends, 0)).toBe('planned');
  });
});

describe('nowLinePercent — лінія «зараз» (BR-CAL-011)', () => {
  // guards: BR-CAL-011
  it('сьогодні в межах робочих годин — відступ за поточним часом Києва', () => {
    expect(nowLinePercent(NOW, DAY, 8, 20)).toBeCloseTo((4 / 12) * 100);
    expect(nowLinePercent(at('2026-10-15T08:30'), DAY, 8, 18)).toBeCloseTo(5);
  });

  // guards: BR-CAL-011
  it('інший день — лінії немає', () => {
    expect(nowLinePercent(NOW, '2026-10-14', 8, 20)).toBeNull();
    expect(nowLinePercent(NOW, '2026-10-16', 8, 20)).toBeNull();
  });

  // guards: BR-CAL-011
  it('до початку й після кінця робочих годин — лінії немає', () => {
    expect(nowLinePercent(at('2026-10-15T07:59'), DAY, 8, 20)).toBeNull();
    expect(nowLinePercent(at('2026-10-15T20:00'), DAY, 8, 20)).toBeNull();
    expect(nowLinePercent(at('2026-10-15T08:00'), DAY, 8, 20)).toBe(0);
  });

  // guards: BR-CAL-011
  it('дата й година — за Києвом із переведенням годинника, не за UTC', () => {
    // 23:30 UTC 15.10 = 02:30 16.10 за Києвом (літній час, +3): це вже 16-те.
    const lateUtc = Date.parse('2026-10-15T23:30:00Z');
    expect(nowLinePercent(lateUtc, '2026-10-15', 0, 23)).toBeNull();
    expect(nowLinePercent(lateUtc, '2026-10-16', 0, 23)).toBeCloseTo((2.5 / 23) * 100);
    // Зима (+2): 10:00 UTC 15.01 = 12:00 Київ.
    expect(nowLinePercent(Date.parse('2026-01-15T10:00:00Z'), '2026-01-15', 8, 20)).toBeCloseTo(
      (4 / 12) * 100,
    );
  });

  it('час ще не відомий (nowMs = 0) — лінії немає', () => {
    expect(nowLinePercent(0, DAY, 8, 20)).toBeNull();
  });
});

describe('pastPercent — приглушене минуле (BR-CAL-011)', () => {
  // guards: BR-CAL-011
  it('сьогодні — до лінії «зараз»; минулий день — уся сітка; майбутній — нічого', () => {
    expect(pastPercent(NOW, DAY, 8, 20)).toBeCloseTo((4 / 12) * 100);
    expect(pastPercent(NOW, '2026-10-14', 8, 20)).toBe(100);
    expect(pastPercent(NOW, '2026-10-16', 8, 20)).toBe(0);
  });

  it('сьогодні до початку годин — нічого, після кінця — уся сітка', () => {
    expect(pastPercent(at('2026-10-15T06:00'), DAY, 8, 20)).toBe(0);
    expect(pastPercent(at('2026-10-15T21:00'), DAY, 8, 20)).toBe(100);
  });
});

describe('liftLoadHours — завантаження підйомника (BR-CAL-011)', () => {
  // guards: BR-CAL-011
  it('сума тривалостей записів цього підйомника; чужий підйомник не рахується', () => {
    const slots = [
      slot('a', '2026-10-15T08:00', '2026-10-15T10:00'),
      slot('b', '2026-10-15T11:00', '2026-10-15T13:30'),
      slot('c', '2026-10-15T14:00', '2026-10-15T18:00', { liftId: 'L2' }),
    ];
    expect(liftLoadHours(slots, 'L1', DAY, 8, 18)).toBe(4.5);
    expect(liftLoadHours(slots, 'L2', DAY, 8, 18)).toBe(4);
  });

  // guards: BR-CAL-011
  it('запис за межами робочих годин обрізається', () => {
    const slots = [
      slot('a', '2026-10-15T06:00', '2026-10-15T09:00'),
      slot('b', '2026-10-15T17:00', '2026-10-15T21:00'),
      slot('c', '2026-10-15T19:00', '2026-10-15T20:00'),
    ];
    expect(liftLoadHours(slots, 'L1', DAY, 8, 18)).toBe(2);
  });

  // guards: BR-CAL-011
  it('частина багатоденного запису — лише своя частина дня', () => {
    // Запис, що триває з учора 16:00 до сьогодні 11:00, і перша частина ланцюжка до завтра.
    const slots = [
      slot('cont', '2026-10-14T16:00', '2026-10-15T11:00'),
      slot('p', '2026-10-15T15:00', '2026-10-16T12:00'),
    ];
    expect(liftLoadHours(slots, 'L1', DAY, 8, 18)).toBe(6);
  });

  // guards: BR-CAL-011
  it('записи скасованих і видалених нарядів не рахуються; службовий запис — рахується', () => {
    const slots = [
      slot('ok', '2026-10-15T08:00', '2026-10-15T10:00'),
      slot('cn', '2026-10-15T10:00', '2026-10-15T12:00', { workOrderStatus: 'CANCELLED' }),
      slot('del', '2026-10-15T12:00', '2026-10-15T14:00', { workOrderDeleted: true }),
      // Видалений і з живим статусом — однаково не рахується.
      slot('del2', '2026-10-15T14:00', '2026-10-15T15:00', {
        workOrderStatus: 'IN_PROGRESS',
        workOrderDeleted: true,
      }),
      slot('svc', '2026-10-15T15:00', '2026-10-15T16:00', { workOrderStatus: null }),
      slot('done', '2026-10-15T16:00', '2026-10-15T17:00', {
        workOrderStatus: 'PAID',
        workOrderDeleted: false,
      }),
    ];
    expect(liftLoadHours(slots, 'L1', DAY, 8, 18)).toBe(4);
  });

  // guards: BR-CAL-011
  it('без записів — 0', () => {
    expect(liftLoadHours([], 'L1', DAY, 8, 18)).toBe(0);
    expect(
      liftLoadHours([slot('a', '2026-10-16T08:00', '2026-10-16T10:00')], 'L1', DAY, 8, 18),
    ).toBe(0);
  });

  // guards: BR-CAL-011
  it.each([
    ['08:00', '08:10', 0],
    ['08:00', '08:15', 0.5],
    ['08:00', '09:10', 1],
    ['08:00', '09:15', 1.5],
    ['08:00', '12:35', 4.5],
    ['08:00', '12:50', 5],
  ])('округлення до 0,5 год: %s–%s → %s', (from, to, hours) => {
    const s = slot('a', `2026-10-15T${from}`, `2026-10-15T${to}`);
    expect(liftLoadHours([s], 'L1', DAY, 8, 18)).toBe(hours);
  });
});
