import type { CalendarSlot, MonthSlots } from './calendar.types';
import type { MonthEntry } from './calendar-categories';

/** Скільки карток записів вміщує клітинка дня; решта — «ще N» (BR-CAL-009). */
export const MONTH_CARD_LIMIT = 3;

/**
 * Ключ ланцюжка багатоденного запису: продовження посилається на перший запис через
 * `parentSlotId`, перший запис — сам на себе (BR-CAL-008).
 */
export function chainKey(slot: Pick<CalendarSlot, 'id' | 'parentSlotId'>): string {
  return slot.parentSlotId ?? slot.id;
}

/** Кінець кожного ланцюжка — найбільший `endAt` серед його частин. */
export function chainEnds(slots: Iterable<CalendarSlot>): Map<string, number> {
  const ends = new Map<string, number>();
  for (const s of slots) {
    const key = chainKey(s);
    const end = new Date(s.endAt).getTime();
    const prev = ends.get(key);
    if (prev === undefined || end > prev) ends.set(key, end);
  }
  return ends;
}

/**
 * Збирає дані виду «Місяць» із відповідей по днях. `days` — дні, що показуються; решта
 * відповідей (перший день наступного місяця) лише продовжують ланцюжки: продовження
 * 1-го числа робить запис останнього дня місяця не простроченим (BR-CAL-008).
 */
export function buildMonthSlots(
  results: readonly { d: string; slots: readonly CalendarSlot[] }[],
  days: readonly string[],
): MonthSlots {
  const ends = chainEnds(results.flatMap(r => r.slots));
  const shown = new Set(days);
  const acc: MonthSlots = {};
  for (const { d, slots } of results) {
    if (!shown.has(d)) continue;
    const byLift: Record<string, number> = {};
    for (const s of slots) {
      if (s.liftId) byLift[s.liftId] = (byLift[s.liftId] ?? 0) + 1;
    }
    const entries: MonthEntry[] = slots.map(s => ({
      slot: s,
      endMs: ends.get(chainKey(s)) ?? new Date(s.endAt).getTime(),
      workOrderStatus: s.workOrderStatus ?? null,
    }));
    acc[d] = { total: slots.length, byLift, entries };
  }
  return acc;
}

/**
 * Картки дня: за часом початку, не більше `MONTH_CARD_LIMIT`; `more` — скільки лишилось
 * за «ще N». Сортування стабільне — записи з однаковим початком лишаються в порядку API.
 */
export function monthCards(entries: readonly MonthEntry[]): {
  cards: MonthEntry[];
  more: number;
} {
  const sorted = [...entries].sort(
    (a, b) => new Date(a.slot.startAt).getTime() - new Date(b.slot.startAt).getTime(),
  );
  return {
    cards: sorted.slice(0, MONTH_CARD_LIMIT),
    more: Math.max(0, sorted.length - MONTH_CARD_LIMIT),
  };
}
