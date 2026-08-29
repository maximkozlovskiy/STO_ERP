const KYIV_YMD = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });

export const kyivToday = (): Date => new Date(KYIV_YMD.format(new Date()));

/**
 * Додає `days` календарних днів до дати `base` і повертає нову Date (date-only, Kyiv).
 * Для `@db.Date` колонок TZ-нюансів немає — беремо Kyiv-локальну опівнічну дату (KYIV_YMD)
 * і додаємо дні через UTC-арифметику, щоб уникнути DST-стрибків.
 */
export const addDaysKyiv = (base: Date, days: number): Date => {
  const ymd = KYIV_YMD.format(base); // 'YYYY-MM-DD' у Kyiv
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return new Date(d.toISOString().slice(0, 10));
};

/**
 * DST-aware offset for Europe/Kyiv at the given UTC instant, in **milliseconds**.
 * Returns +7_200_000 (EET +02:00) у зимовий період, +10_800_000 (EEST +03:00) у літній.
 *
 * Logic-bug fix: попередня реалізація ділила різницю мілісекунд на 60_000 → результат у
 * хвилинах попри назву `…Ms`. Метод був мертвим кодом (жоден сервіс не імпортував його з
 * цього файлу — кожен мав власну копію в reports.service / calendar.service), але назва
 * обіцяла ms, що мало шанси на silent failure при першому ж новому імпорті.
 */
export const kyivOffsetMs = (d: Date): number => {
  const kyivStr = d.toLocaleString('en-US', { timeZone: 'Europe/Kyiv', hour12: false });
  const kyivDate = new Date(kyivStr + ' UTC');
  return kyivDate.getTime() - d.getTime();
};
