/**
 * Дати E2E з плановими датами наряду й записами календаря: вихідні філії (BR-WO-019, BR-CAL-016)
 * у пікері недоступні, а сервер відхиляє їх 400 і переносить на них залишок запису. Фіксоване
 * число наступного місяця раз на кілька місяців падало на неділю — тест ламався від дати прогону.
 *
 * Тому спеки беруть N-ний день пн–чт наступного місяця (у місяці їх щонайменше 16): і сам день, і
 * наступний (переповнення запису) робочі і при пн–пт, і при пн–сб. Номери в спеків різні — сітка
 * дня перебудовується на чужі записи тієї самої дати, і перетягування влучало в сусідній рядок
 * (work-order-lookups-roles, 2026-11-01):
 *   2–6 work-order-lookups-roles (копії `--repeat-each`) · 7 calendar-owner-decisions ·
 *   8 work-order-calendar-record · 9 calendar-slot-types · 10 work-order-calendar-drag ·
 *   11 work-order-calendar-edit · 12 work-order-calendar-lifecycle · 13 work-order-days-off.
 */

const DAY_MS = 86_400_000;
const isMonThu = (d: Date) => d.getUTCDay() >= 1 && d.getUTCDay() <= 4;

const kyivToday = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());

/** N-ний (з 1) день пн–чт наступного місяця, 'YYYY-MM-DD'. */
export function weekdayOfNextMonth(n: number): string {
  const [y, m] = kyivToday().split('-').map(Number) as [number, number];
  // m — 1-based, тож Date.UTC(y, m, 1) — 1-ше число наступного місяця.
  let t = Date.UTC(y, m, 1);
  let seen = isMonThu(new Date(t)) ? 1 : 0;
  while (seen < n) {
    t += DAY_MS;
    if (isMonThu(new Date(t))) seen += 1;
  }
  return new Date(t).toISOString().slice(0, 10);
}

/** Дата 'YYYY-MM-DD' — пн–чт (для переліку днів-кандидатів). */
export const isMonThuDate = (ymd: string): boolean => isMonThu(new Date(`${ymd}T12:00:00Z`));
