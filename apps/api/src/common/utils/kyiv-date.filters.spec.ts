/**
 * Фільтри «з дня / по день» для списків документів: київська доба для міток часу, календарна
 * дата для `@db.Date`, перевірка існування дати.
 *
 * Bug #808 (звіт «Виручка» зсував день назад) і Bug #798 — саме про плутанину між датою без
 * часу і міткою часу; тому дві функції, і різницю між ними тримають тести.
 */
import { describe, it, expect } from 'vitest';
import { dateOnlyRangeFilter, isCalendarDate, kyivDayRangeFilter } from './kyiv-date';

describe('kyivDayRangeFilter — межі київської доби для DateTime', () => {
  it('літо (UTC+3): 09.07 — це 08.07 21:00Z … 09.07 20:59:59.999Z', () => {
    const r = kyivDayRangeFilter('2026-07-09', '2026-07-09')!;
    expect(r.gte!.toISOString()).toBe('2026-07-08T21:00:00.000Z');
    expect(r.lte!.toISOString()).toBe('2026-07-09T20:59:59.999Z');
  });

  it('зима (UTC+2): 15.01 — це 14.01 22:00Z … 15.01 21:59:59.999Z', () => {
    const r = kyivDayRangeFilter('2026-01-15', '2026-01-15')!;
    expect(r.gte!.toISOString()).toBe('2026-01-14T22:00:00.000Z');
    expect(r.lte!.toISOString()).toBe('2026-01-15T21:59:59.999Z');
  });

  // Дні переведення годинника (остання неділя березня й жовтня, перехід о 01:00Z): доба
  // починається в одному поясі, а закінчується в іншому — зсув кожної межі береться окремо.
  it('29.03.2026 (перехід на літній час): доба з 23 годин — 28.03 22:00Z … 29.03 20:59:59.999Z', () => {
    const r = kyivDayRangeFilter('2026-03-29', '2026-03-29')!;
    expect(r.gte!.toISOString()).toBe('2026-03-28T22:00:00.000Z');
    expect(r.lte!.toISOString()).toBe('2026-03-29T20:59:59.999Z');
    expect(r.lte!.getTime() - r.gte!.getTime() + 1).toBe(23 * 3_600_000);
  });

  it('25.10.2026 (перехід на зимовий час): доба з 25 годин — 24.10 21:00Z … 25.10 21:59:59.999Z', () => {
    const r = kyivDayRangeFilter('2026-10-25', '2026-10-25')!;
    expect(r.gte!.toISOString()).toBe('2026-10-24T21:00:00.000Z');
    expect(r.lte!.toISOString()).toBe('2026-10-25T21:59:59.999Z');
    expect(r.lte!.getTime() - r.gte!.getTime() + 1).toBe(25 * 3_600_000);
  });

  it('сусідні доби не перетинаються і не лишають проміжку — і довкола переходу теж', () => {
    for (const [day, next] of [
      ['2026-03-28', '2026-03-29'],
      ['2026-03-29', '2026-03-30'],
      ['2026-10-24', '2026-10-25'],
      ['2026-10-25', '2026-10-26'],
      ['2026-07-09', '2026-07-10'],
    ] as const) {
      const a = kyivDayRangeFilter(day, day)!;
      const b = kyivDayRangeFilter(next, next)!;
      expect(b.gte!.getTime() - a.lte!.getTime()).toBe(1);
    }
  });

  it('операція о 00:20 за Києвом потрапляє у свій день, а не в попередній', () => {
    const op = new Date('2026-10-08T21:20:00.000Z'); // 09.10 00:20 Київ
    const day9 = kyivDayRangeFilter('2026-10-09', '2026-10-09')!;
    const day8 = kyivDayRangeFilter('2026-10-08', '2026-10-08')!;
    expect(op >= day9.gte! && op <= day9.lte!).toBe(true);
    expect(op >= day8.gte! && op <= day8.lte!).toBe(false);
  });

  it('лише «з» або лише «по» — одна межа; жодної — undefined (умову не додають)', () => {
    expect(kyivDayRangeFilter('2026-07-09')).toEqual({ gte: new Date('2026-07-08T21:00:00.000Z') });
    expect(kyivDayRangeFilter(undefined, '2026-07-09')).toEqual({
      lte: new Date('2026-07-09T20:59:59.999Z'),
    });
    expect(kyivDayRangeFilter()).toBeUndefined();
    expect(kyivDayRangeFilter('', '')).toBeUndefined();
  });
});

// Bug #818: рідне поле дати, поки користувач набирає рік, віддає `0002-10-09`, `0020-10-09`.
// Зсув для років 0–99 рахувався через рядок «10/9/2», який `new Date` читає як 2002 рік: межа
// виходила на ~2000 років раніше, і Postgres відповідав помилкою (500 на кожній набраній даті).
// Mutation-verify: прибрати гілку `getUTCFullYear() < 100` у kyivOffsetMs → кейси років 0–99
// падають; прибрати `Math.max(…, EARLIEST_DB_INSTANT_MS)` → падає третій.
describe('kyivDayRangeFilter — роки з початку нашої ери (ввід року по одній цифрі)', () => {
  it.each(['0002-10-09', '0020-10-09', '0099-12-31'])(
    '%s: межі лежать у тій самій добі (місцевий середній час Києва, +02:02:04)',
    day => {
      const r = kyivDayRangeFilter(day, day)!;
      const wallStart = new Date(`${day}T00:00:00.000Z`).getTime();
      expect(wallStart - r.gte!.getTime()).toBe(7_324_000);
      expect(r.lte!.getTime() - r.gte!.getTime() + 1).toBe(24 * 3_600_000);
    },
  );

  it('рік 0100 і далі рахуються як раніше — та сама формула, той самий зсув', () => {
    const r = kyivDayRangeFilter('0100-10-09', '0100-10-09')!;
    expect(r.gte!.toISOString()).toBe('0100-10-08T21:57:56.000Z');
    expect(r.lte!.toISOString()).toBe('0100-10-09T21:57:55.999Z');
  });

  it('початок 0001-01-01 не виходить у рік 0, якого Postgres не приймає', () => {
    const r = kyivDayRangeFilter('0001-01-01', '0001-01-01')!;
    expect(r.gte!.toISOString()).toBe('0001-01-01T00:00:00.000Z');
    expect(r.lte!.toISOString()).toBe('0001-01-01T21:57:55.999Z');
  });
});

describe('dateOnlyRangeFilter — межі для колонки @db.Date', () => {
  it('межі — самі календарні дати, без зсуву на пояс; обидві включні', () => {
    expect(dateOnlyRangeFilter('2026-10-08', '2026-10-09')).toEqual({
      gte: new Date('2026-10-08T00:00:00.000Z'),
      lte: new Date('2026-10-09T00:00:00.000Z'),
    });
  });

  it('один день: gte = lte = ця дата (рядок з датою 09.10 входить, 08.10 і 10.10 — ні)', () => {
    const r = dateOnlyRangeFilter('2026-10-09', '2026-10-09')!;
    const stored = (d: string) => new Date(`${d}T00:00:00.000Z`); // так Prisma віддає @db.Date
    const inside = (d: string) => stored(d) >= r.gte! && stored(d) <= r.lte!;
    expect(inside('2026-10-09')).toBe(true);
    expect(inside('2026-10-08')).toBe(false);
    expect(inside('2026-10-10')).toBe(false);
  });

  it('жодної межі — undefined', () => {
    expect(dateOnlyRangeFilter()).toBeUndefined();
  });
});

describe('isCalendarDate', () => {
  it.each(['2026-10-09', '2024-02-29', '2026-12-31', '0001-01-01', '0002-10-09'])(
    '%s — існує',
    v => {
      expect(isCalendarDate(v)).toBe(true);
    },
  );

  // Bug #818: року 0000 в календарі немає — 400, а не 500 від бази.
  it.each(['0000-01-01', '0000-12-31'])('%s — року 0000 не існує', v => {
    expect(isCalendarDate(v)).toBe(false);
  });

  it.each(['2026-02-31', '2026-02-29', '2026-13-01', '09.10.2026', '2026-10-9', 'сьогодні', ''])(
    '%j — не дата (31.02 не перекочується в березень)',
    v => {
      expect(isCalendarDate(v)).toBe(false);
    },
  );
});
