import type { CalendarSlot } from './calendar.types';
import { slotCategory, type SlotCategory } from './calendar-categories';
import { chainKey } from './calendar-month';
import { decimalHoursToISO, kyivHours, toDateString } from './calendar.utils';

/**
 * Категорія блоку запису у виді «День» (BR-CAL-011) — та сама, що в «Місяці» (BR-CAL-008):
 * «прострочено» — за кінцем ЛАНЦЮЖКА (`chainEnds` із записів дня й наступного дня), а не за
 * кінцем частини, що показана.
 */
export function daySlotCategory(
  slot: Pick<CalendarSlot, 'id' | 'parentSlotId' | 'endAt' | 'workOrderStatus'>,
  chainEnds: ReadonlyMap<string, number>,
  nowMs: number,
): SlotCategory {
  return slotCategory(
    {
      endMs: chainEnds.get(chainKey(slot)) ?? new Date(slot.endAt).getTime(),
      workOrderStatus: slot.workOrderStatus ?? null,
    },
    nowMs,
  );
}

/** Поточний час за Києвом як частка робочого вікна дня, %; `null` — не сьогодні. */
function kyivTodayHours(nowMs: number, date: string): number | null {
  if (!nowMs || !date) return null;
  const now = new Date(nowMs);
  // Дата й година — за Києвом (Intl, з переведенням годинника), не за часовим поясом браузера.
  if (toDateString(now) !== date) return null;
  return kyivHours(now.toISOString());
}

/**
 * Лінія «зараз» (BR-CAL-011): відступ від початку робочих годин у % ширини сітки — лише для
 * сьогоднішнього дня за Києвом і лише в межах робочих годин `[startHour, endHour)`; інакше `null`.
 * `nowMs` = 0 — час ще не відомий (до гідратації): лінії немає.
 */
export function nowLinePercent(
  nowMs: number,
  date: string,
  startHour: number,
  endHour: number,
): number | null {
  const h = kyivTodayHours(nowMs, date);
  if (h === null || endHour <= startHour || h < startHour || h >= endHour) return null;
  return ((h - startHour) / (endHour - startHour)) * 100;
}

/**
 * Скільки % ширини сітки приглушено як минуле: минулий день — уся, майбутній — нічого, сьогодні —
 * до лінії «зараз» (до початку робочих годин — нічого, після кінця — уся).
 */
export function pastPercent(
  nowMs: number,
  date: string,
  startHour: number,
  endHour: number,
): number {
  if (!nowMs || !date || endHour <= startHour) return 0;
  const today = toDateString(new Date(nowMs));
  if (date < today) return 100;
  if (date > today) return 0;
  const h = kyivTodayHours(nowMs, date) ?? startHour;
  return Math.min(100, Math.max(0, ((h - startHour) / (endHour - startHour)) * 100));
}

const HOUR_MS = 3_600_000;

/**
 * Завантаження підйомника за день (BR-CAL-011): сума тривалостей його записів у межах робочих
 * годин дня `date` (Київ). Запис, що виходить за межі, обрізається; частина багатоденного запису
 * рахується лише своєю частиною цього дня. Результат — години, округлені до 0,5.
 */
export function liftLoadHours(
  slots: readonly Pick<CalendarSlot, 'liftId' | 'startAt' | 'endAt'>[],
  liftId: string,
  date: string,
  startHour: number,
  endHour: number,
): number {
  const from = new Date(decimalHoursToISO(date, startHour)).getTime();
  const to = new Date(decimalHoursToISO(date, endHour)).getTime();
  if (!(to > from)) return 0;
  let ms = 0;
  for (const s of slots) {
    if (s.liftId !== liftId) continue;
    const a = Math.max(new Date(s.startAt).getTime(), from);
    const b = Math.min(new Date(s.endAt).getTime(), to);
    if (b > a) ms += b - a;
  }
  return Math.round((ms / HOUR_MS) * 2) / 2;
}
