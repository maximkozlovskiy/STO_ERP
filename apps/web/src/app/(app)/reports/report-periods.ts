/**
 * Швидкі періоди звітів: «Цей місяць · Минулий місяць · Квартал · Рік» (огляд звітів 2026-10-29).
 *
 * Межі — київські календарні дати `YYYY-MM-DD` від `today` (`kyivToday()`), без `Date` у часовому
 * поясі браузера. Поточні місяць, квартал і рік — від першого дня до сьогодні (звіт за майбутнє
 * порожній); минулий місяць — повністю.
 */

export const QUICK_PERIODS = ['month', 'prevMonth', 'quarter', 'year'] as const;
export type QuickPeriod = (typeof QUICK_PERIODS)[number];

const pad = (n: number) => String(n).padStart(2, '0');

/** Останній день місяця `month` (1–12) року `year`. */
function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function quickPeriodRange(kind: QuickPeriod, today: string): { from: string; to: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  switch (kind) {
    case 'month':
      return { from: `${y}-${pad(m)}-01`, to: today };
    case 'prevMonth': {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(lastDay(py, pm))}` };
    }
    case 'quarter':
      return { from: `${y}-${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`, to: today };
    case 'year':
      return { from: `${y}-01-01`, to: today };
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/** Який швидкий період збігається з `from..to` (для підсвічування кнопки), або `null`. */
export function activeQuickPeriod(from: string, to: string, today: string): QuickPeriod | null {
  return (
    QUICK_PERIODS.find(k => {
      const r = quickPeriodRange(k, today);
      return r.from === from && r.to === to;
    }) ?? null
  );
}
