import { describe, it, expect } from 'vitest';
import { DEFAULT_WORK_HOURS } from '@sto/shared';
import {
  kyivHourOnDay,
  kyivMinuteOfDay,
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
  it('рядок філії → його години', () => {
    expect(workHoursOf({ workStartTime: '08:00', workEndTime: '20:00' })).toEqual({
      startHour: 8,
      endHour: 20,
    });
  });

  it.each([
    ['рядка немає', null],
    ['невалідний час', { workStartTime: 'foo', workEndTime: 'bar' }],
    ['кінець не пізніше початку', { workStartTime: '20:00', workEndTime: '09:00' }],
  ])('%s → типові 09–18 (ті самі, що @default BranchSettings)', (_l, row) => {
    expect(workHoursOf(row)).toEqual({ startHour: 9, endHour: 18 });
    expect(DEFAULT_WORK_HOURS).toEqual({ startHour: 9, endHour: 18 });
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
