import { kyivOffsetMs, kyivWallTimeToUtc, kyivYmd } from '../../common/utils/kyiv-date';

// Форматування значень змінних шаблону (BR-AUT-014) і тихі години (BR-AUT-013). Чисті функції —
// двигун і «Надіслати тест» підставляють однаково.

// Module-level: Intl.*Format дорогий в ініціалізації — не в циклі.
const MONEY_FMT = new Intl.NumberFormat('uk-UA', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const DATE_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const TIME_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** «1 250,00 грн» (локаль uk-UA, CLAUDE.md «Локаль та форматування»). */
export const formatMoneyUah = (amount: number): string => `${MONEY_FMT.format(amount)} грн`;

/** «29.10.2026» — дата за Києвом. */
export const formatKyivDate = (d: Date): string => DATE_FMT.format(d);

/** «14:05» — час за Києвом (24 год). */
export const formatKyivTime = (d: Date): string => TIME_FMT.format(d);

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** «ГГ:ХХ» → хвилини від півночі; некоректне значення — null (тихі години вимкнено). */
export function parseHhMm(value: string | null | undefined): number | null {
  const m = HHMM_RE.exec(value ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Наступна календарна дата `YYYY-MM-DD` (UTC-арифметика дат — без DST-стрибків). */
function nextYmd(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * BR-AUT-013: скільки мілісекунд відкласти повідомлення клієнту, що виникло в `now`. Вікно тихих
 * годин `[start, end)` за Києвом (DST через `kyivOffsetMs`, ніколи `+03:00`), може переходити через
 * північ (21:00–09:00). Поза вікном, однакові межі або некоректний формат — 0.
 */
export function quietHoursDelayMs(now: Date, start: string, end: string): number {
  const s = parseHhMm(start);
  const e = parseHhMm(end);
  if (s === null || e === null || s === e) return 0;
  const wall = new Date(now.getTime() + kyivOffsetMs(now));
  const minute = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  const inside = s < e ? minute >= s && minute < e : minute >= s || minute < e;
  if (!inside) return 0;
  const today = kyivYmd(now);
  // Кінець вікна — сьогодні, якщо він ще попереду; інакше (вечір після початку) — завтра.
  const endDay = minute < e ? today : nextYmd(today);
  const endAt = kyivWallTimeToUtc(`${endDay}T${pad2(Math.floor(e / 60))}:${pad2(e % 60)}:00`);
  return Math.max(0, endAt.getTime() - now.getTime());
}
