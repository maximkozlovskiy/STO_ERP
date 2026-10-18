/**
 * Спільне для спеків запису наряду в календарі — видалення й статус
 * (`work-orders.calendar-slot-lifecycle.spec.ts`) і перев'язка, відв'язка, новий запис
 * (`work-orders.calendar-slot-relink.spec.ts`). Наряди й записи — таблиці в пам'яті
 * `work-orders.planning.spec-fixture.ts` (`$transaction` відкочує таблиці при винятку).
 */
import { expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import {
  LIFT_1,
  OTHER_WO,
  WO_ID,
  kyiv,
  planningHarness,
  slotRow,
  woRow,
} from './work-orders.planning.spec-fixture';

export const D = '2026-05-22';
export const D2 = '2026-05-23';
export const USER = 'user-1';
export const t = (d: unknown) => (d as Date).getTime();
export const iso = (day: string, hhmm: string) => kyiv(day, hhmm).toISOString();

export type Harness = ReturnType<typeof planningHarness>;
export type Row = Record<string, unknown>;

/**
 * WO_ID (D 10:00–12:00 на LIFT_1, «Нормогодин» 2 — виведені з дат) з якорем `anchor`; OTHER_WO —
 * за `other` (за замовчуванням чернетка без дат).
 */
export function planned(over: { wo?: Row; other?: Row; anchor?: Row; extra?: Row[] } = {}) {
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
export function twoDays(woOver: Row = {}) {
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

export const woOf = (h: Harness, id = WO_ID) => h.workOrder.rows.find(w => w.id === id)!;
export const slotOf = (h: Harness, id: string) => h.calendarSlot.rows.find(s => s.id === id)!;
export const snapshot = (h: Harness) => structuredClone([h.workOrder.rows, h.calendarSlot.rows]);

export async function rejected(h: Harness, p: Promise<unknown>, ErrorType = BadRequestException) {
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

export const msg = (key: string) => translateError(key, 'uk');
