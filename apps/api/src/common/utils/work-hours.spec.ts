import { describe, it, expect } from 'vitest';
import { DEFAULT_WORK_HOURS } from '@sto/shared';
import {
  effectiveWorkDays,
  isWorkDay,
  kyivHourOnDay,
  kyivMinuteOfDay,
  nextWorkDay,
  splitByWorkHours,
  workCapacityHours,
  workDayHoursOf,
  workDaysOf,
  workHoursOf,
} from './work-hours';

// Робочі години філії — одне джерело для календаря, `GET /settings/work-hours` і планових дат
// наряду (BR-WO-019, BR-WO-020). Час — київський, із переведенням годинника (25.10.2026 — на +02).

const iso = (d: Date) => d.toISOString();

describe('workHoursOf — години з BranchSettings', () => {
  it('рядок філії → його години й робочі дні (без поля — пн–пт, як @default колонки)', () => {
    expect(workHoursOf({ workStartTime: '08:00', workEndTime: '20:00' })).toEqual({
      startHour: 8,
      endHour: 20,
      workDays: [1, 2, 3, 4, 5],
    });
    expect(
      workHoursOf({ workStartTime: '08:00', workEndTime: '20:00', workDays: [1, 2, 3, 4, 5, 6] }),
    ).toEqual({ startHour: 8, endHour: 20, workDays: [1, 2, 3, 4, 5, 6] });
  });

  it.each([
    ['невалідний час', { workStartTime: 'foo', workEndTime: 'bar' }],
    ['кінець не пізніше початку', { workStartTime: '20:00', workEndTime: '09:00' }],
  ])('%s → типові 09–18 (ті самі, що @default BranchSettings), дні рядка лишаються', (_l, row) => {
    expect(workHoursOf(row)).toEqual({ startHour: 9, endHour: 18, workDays: [1, 2, 3, 4, 5] });
    expect(DEFAULT_WORK_HOURS).toEqual({ startHour: 9, endHour: 18 });
  });

  // guards: BR-WO-019
  it('рядка немає → типові 09–18 без переліку днів: кожен день робочий', () => {
    expect(workHoursOf(null)).toEqual({ startHour: 9, endHour: 18 });
  });

  // guards: BR-WO-019
  it('дні поза 1..7 відкидаються; лише такі → порожній перелік, тобто кожен день робочий', () => {
    expect(workHoursOf({ workDays: [0, 6, 8, 7] }).workDays).toEqual([6, 7]);
    expect(workHoursOf({ workDays: [0, 8] }).workDays).toEqual([]);
  });
});

// Вихідні філії (рішення власника 2026-10-30): 21.11.2026 — сб, 22.11 — нд, 23.11 — пн.
describe('isWorkDay / nextWorkDay / effectiveWorkDays — робочі дні філії (BR-WO-019, BR-CAL-016)', () => {
  const MON_SAT = { workDays: [1, 2, 3, 4, 5, 6] };

  // guards: BR-WO-019
  it('день тижня — ISO з самої дати; неділя (7) — вихідний пн–сб', () => {
    expect(isWorkDay('2026-11-21', MON_SAT)).toBe(true);
    expect(isWorkDay('2026-11-22', MON_SAT)).toBe(false);
    expect(isWorkDay('2026-11-22', { workDays: [7] })).toBe(true);
    // DST-неділя 25.10.2026 — так само неділя.
    expect(isWorkDay('2026-10-25', MON_SAT)).toBe(false);
  });

  // guards: BR-WO-019
  it('переліку немає чи він порожній → кожен день робочий', () => {
    expect(isWorkDay('2026-11-22', {})).toBe(true);
    expect(isWorkDay('2026-11-22', { workDays: [] })).toBe(true);
  });

  // guards: BR-CAL-016
  it('наступний робочий день: сб → пн (пн–сб), пт → пн (пн–пт), без переліку — завтра', () => {
    expect(nextWorkDay('2026-11-21', MON_SAT)).toBe('2026-11-23');
    expect(nextWorkDay('2026-11-20', { workDays: [1, 2, 3, 4, 5] })).toBe('2026-11-23');
    expect(nextWorkDay('2026-11-21', {})).toBe('2026-11-22');
    // Робочий лише понеділок — пошук не довший за тиждень.
    expect(nextWorkDay('2026-11-23', { workDays: [1] })).toBe('2026-11-30');
  });

  // guards: BR-WO-019
  it('для відповіді API: перелік відсортований без повторів, «кожен день» — усі сім', () => {
    expect(effectiveWorkDays({ workDays: [6, 1, 1, 2] })).toEqual([1, 2, 6]);
    expect(effectiveWorkDays({})).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(effectiveWorkDays({ workDays: [] })).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

// BR-RPT-033: місткість «Завантаженості» — робочий час філії; дні тижня ISO (1 = пн … 7 = нд).
// Mutation-verify (2026-10-29): `getUTCDay()` без `|| 7` → падає «неділя»; цілі години замість
// хвилин → падає «08:30»; крок циклу від півночі за місцевим часом не впливає — день із дати.
describe('workDaysOf / workDayHoursOf / workCapacityHours — робочий час філії', () => {
  // guards: BR-RPT-033
  it('дні: рядка немає чи не масив → пн–пт; масив — як є', () => {
    expect(workDaysOf(null)).toEqual([1, 2, 3, 4, 5]);
    expect(workDaysOf({ workDays: 'x' })).toEqual([1, 2, 3, 4, 5]);
    expect(workDaysOf({ workDays: [6, 7] })).toEqual([6, 7]);
  });

  // guards: BR-RPT-033
  it('тривалість дня — з хвилинами; невалідне чи кінець раніше початку → 9 год', () => {
    expect(workDayHoursOf({ workStartTime: '08:30', workEndTime: '17:00' })).toBe(8.5);
    expect(workDayHoursOf(null)).toBe(9);
    expect(workDayHoursOf({ workStartTime: '20:00', workEndTime: '09:00' })).toBe(9);
  });

  // guards: BR-RPT-033
  it('місткість: робочі дні періоду × тривалість дня; неділя — день 7; DST не впливає', () => {
    // 19–25.10.2026: пн–нд, 25.10 — переведення годинника.
    expect(workCapacityHours('2026-10-19', '2026-10-25', null)).toBe(45);
    expect(workCapacityHours('2026-10-25', '2026-10-25', { workDays: [7] })).toBe(9);
    expect(workCapacityHours('2026-10-24', '2026-10-25', null)).toBe(0);
    expect(
      workCapacityHours('2026-10-19', '2026-10-25', {
        workStartTime: '08:30',
        workEndTime: '17:00',
        workDays: [1, 2, 3, 4, 5, 6],
      }),
    ).toBe(51);
  });
});

describe('kyivMinuteOfDay / kyivHourOnDay — київський час з переведенням годинника', () => {
  it('літо (+03): 05:30Z — 08:30 Києва; зима (+02): 05:30Z — 07:30', () => {
    expect(kyivMinuteOfDay(new Date('2026-05-22T05:30:00Z'))).toBe(8 * 60 + 30);
    expect(kyivMinuteOfDay(new Date('2026-10-26T05:30:00Z'))).toBe(7 * 60 + 30);
  });

  it('година дня → мить UTC з урахуванням зсуву дня', () => {
    expect(iso(kyivHourOnDay('2026-05-22', 18))).toBe('2026-05-22T15:00:00.000Z');
    expect(iso(kyivHourOnDay('2026-10-26', 18))).toBe('2026-10-26T16:00:00.000Z');
  });
});

describe('splitByWorkHours — запис наряду по днях робочих годин (BR-WO-020)', () => {
  const H = { startHour: 8, endHour: 18 };

  // guards: BR-WO-020
  it('один день у межах годин → один відрізок як є', () => {
    const s = splitByWorkHours(
      new Date('2026-05-22T07:00:00Z'),
      new Date('2026-05-22T09:00:00Z'),
      H,
    );
    expect(s.map(x => [iso(x.startAt), iso(x.endAt)])).toEqual([
      ['2026-05-22T07:00:00.000Z', '2026-05-22T09:00:00.000Z'],
    ]);
  });

  // guards: BR-WO-020
  it('з 16:00 до завтра 11:00 → 16:00–18:00 і 08:00–11:00 (ніч не займає підйомник)', () => {
    const s = splitByWorkHours(
      new Date('2026-05-22T13:00:00Z'),
      new Date('2026-05-23T08:00:00Z'),
      H,
    );
    expect(s.map(x => [iso(x.startAt), iso(x.endAt)])).toEqual([
      ['2026-05-22T13:00:00.000Z', '2026-05-22T15:00:00.000Z'],
      ['2026-05-23T05:00:00.000Z', '2026-05-23T08:00:00.000Z'],
    ]);
  });

  it('три дні → по відрізку на день; середній — увесь робочий день', () => {
    const s = splitByWorkHours(
      new Date('2026-05-22T13:00:00Z'),
      new Date('2026-05-24T07:00:00Z'),
      H,
    );
    expect(s).toHaveLength(3);
    expect([iso(s[1]!.startAt), iso(s[1]!.endAt)]).toEqual([
      '2026-05-23T05:00:00.000Z',
      '2026-05-23T15:00:00.000Z',
    ]);
  });

  it('перехід на зимовий час між днями: другий день відкривається о 08:00 за +02', () => {
    const s = splitByWorkHours(
      new Date('2026-10-24T13:00:00Z'), // 16:00 Києва, +03
      new Date('2026-10-26T08:00:00Z'), // 10:00 Києва, +02
      H,
    );
    expect(s.map(x => iso(x.startAt))).toEqual([
      '2026-10-24T13:00:00.000Z',
      '2026-10-25T06:00:00.000Z',
      '2026-10-26T06:00:00.000Z',
    ]);
  });

  it('зовсім поза годинами чи кінець ≤ початку → порожньо', () => {
    expect(
      splitByWorkHours(new Date('2026-05-22T16:00:00Z'), new Date('2026-05-22T18:00:00Z'), H),
    ).toEqual([]);
    expect(
      splitByWorkHours(new Date('2026-05-22T09:00:00Z'), new Date('2026-05-22T09:00:00Z'), H),
    ).toEqual([]);
  });
});

// Рішення власника 2026-10-30 (TECH-DEBT (б) №65): розбиття запису по днях пропускає вихідні.
describe('splitByWorkHours — вихідні філії (BR-CAL-016)', () => {
  const H = { startHour: 9, endHour: 18, workDays: [1, 2, 3, 4, 5, 6] };

  // guards: BR-CAL-016
  it('сб 17:00 → пн 11:00 при пн–сб: відрізки сб 17–18 і пн 09–11, неділі немає', () => {
    const s = splitByWorkHours(
      new Date('2026-11-21T15:00:00Z'), // сб 17:00 Києва (+02)
      new Date('2026-11-23T09:00:00Z'), // пн 11:00
      H,
    );
    expect(s.map(x => [iso(x.startAt), iso(x.endAt)])).toEqual([
      ['2026-11-21T15:00:00.000Z', '2026-11-21T16:00:00.000Z'],
      ['2026-11-23T07:00:00.000Z', '2026-11-23T09:00:00.000Z'],
    ]);
  });

  // guards: BR-CAL-016
  it('той самий проміжок без переліку днів → неділя теж має відрізок (кожен день робочий)', () => {
    const s = splitByWorkHours(new Date('2026-11-21T15:00:00Z'), new Date('2026-11-23T09:00:00Z'), {
      startHour: 9,
      endHour: 18,
    });
    expect(s.map(x => iso(x.startAt))).toEqual([
      '2026-11-21T15:00:00.000Z',
      '2026-11-22T07:00:00.000Z',
      '2026-11-23T07:00:00.000Z',
    ]);
  });

  // guards: BR-CAL-016
  it('проміжок цілком на вихідному → порожньо', () => {
    expect(
      splitByWorkHours(new Date('2026-11-22T08:00:00Z'), new Date('2026-11-22T10:00:00Z'), H),
    ).toEqual([]);
  });
});
