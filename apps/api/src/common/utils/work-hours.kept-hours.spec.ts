import { describe, it, expect } from 'vitest';
import {
  endFromWorkHours,
  sameWorkHours,
  slotEndFromWorkHours,
  slotWorkHours,
  workHoursBetween,
  type WorkHours,
} from './work-hours';

// Нормогодини ↔ кінець за робочими годинами філії (№98, BR-CAL-020, BR-WO-040): зміна підйомника на
// підйомник філії з іншими годинами зберігає нормогодини — кінець рахується від того ж початку за
// годинами нової філії. `endFromWorkHours` — дзеркало web `calcEndFromHours` (картка наряду),
// `slotWorkHours` / `slotEndFromWorkHours` — web `slotHoursBetween` / `slotEndFromHours` (форма
// запису календаря): форма й сервер мусять рахувати однаково. Час — київський: 22.05.2026 — пт,
// +03:00; 25.10.2026 — нд, перехід на +02:00; 29.03.2026 — нд, перехід на +03:00.

const at = (ymd: string, hm: string, offset = '+03:00') => new Date(`${ymd}T${hm}:00${offset}`);
const iso = (d: Date | null) => d?.toISOString() ?? null;

const MON_FRI: WorkHours = { startHour: 9, endHour: 18, workDays: [1, 2, 3, 4, 5] };
const MON_SAT: WorkHours = { startHour: 9, endHour: 18, workDays: [1, 2, 3, 4, 5, 6] };
const DAILY_8_20: WorkHours = { startHour: 8, endHour: 20, workDays: [1, 2, 3, 4, 5, 6, 7] };

const FRI = '2026-05-22';
const SAT = '2026-05-23';
const SUN = '2026-05-24';
const MON = '2026-05-25';
const TUE = '2026-05-26';

describe('endFromWorkHours — кінець за нормогодинами в робочих годинах (дзеркало calcEndFromHours)', () => {
  // guards: BR-WO-040
  it.each([
    ['у межах дня', at(FRI, '10:00'), 2, MON_FRI, at(FRI, '12:00')],
    [
      'залишок рівно до закриття — закриття того ж дня',
      at(FRI, '15:00'),
      3,
      MON_FRI,
      at(FRI, '18:00'),
    ],
    [
      'вихідні пропущено: пт 17:00 + 3 год → пн 11:00',
      at(FRI, '17:00'),
      3,
      MON_FRI,
      at(MON, '11:00'),
    ],
    ['робоча субота: пт 17:00 + 3 год → сб 11:00', at(FRI, '17:00'), 3, MON_SAT, at(SAT, '11:00')],
    ['кілька днів: пт 16:00 + 18 год → вт 16:00', at(FRI, '16:00'), 18, MON_FRI, at(TUE, '16:00')],
    ['початок до відкриття — від відкриття', at(FRI, '07:00'), 2, MON_FRI, at(FRI, '11:00')],
    [
      'початок о закритті — від відкриття наступного робочого',
      at(FRI, '18:00'),
      1,
      MON_FRI,
      at(MON, '10:00'),
    ],
    ['початок у вихідний — від відкриття робочого', at(SUN, '12:00'), 1, MON_FRI, at(MON, '10:00')],
    ['дробові: 1,5 год', at(FRI, '10:15'), 1.5, MON_FRI, at(FRI, '11:45')],
    ['дробові через ніч: 2,25 год від 17:00', at(FRI, '17:00'), 2.25, MON_FRI, at(MON, '10:15')],
  ])('%s', (_l, start, hours, wh, end) => {
    expect(iso(endFromWorkHours(start, hours, wh))).toBe(iso(end));
  });

  // guards: BR-WO-040
  it('переведення годинника: години дня — київські й після переходу (+02:00 восени, +03:00 навесні)', () => {
    // Сб 24.10 17:00 (+03) + 4 год при 08–20 щодня: 3 год у сб, 1 год у нд 25.10 від 08:00 (+02).
    expect(iso(endFromWorkHours(at('2026-10-24', '17:00'), 4, DAILY_8_20))).toBe(
      iso(at('2026-10-25', '09:00', '+02:00')),
    );
    // Сб 28.03 19:00 (+02) + 2 год: 1 год у сб, 1 год у нд 29.03 від 08:00 (+03).
    expect(iso(endFromWorkHours(at('2026-03-28', '19:00', '+02:00'), 2, DAILY_8_20))).toBe(
      iso(at('2026-03-29', '09:00')),
    );
  });

  // guards: BR-WO-040
  it.each([
    ['нуль годин', at(FRI, '10:00'), 0, MON_FRI],
    ['від’ємні', at(FRI, '10:00'), -1, MON_FRI],
    ['не число', at(FRI, '10:00'), Number.NaN, MON_FRI],
    ['невалідна дата', new Date('x'), 2, MON_FRI],
    ['порожнє вікно', at(FRI, '10:00'), 2, { startHour: 10, endHour: 10 }],
  ])('%s → null', (_l, start, hours, wh) => {
    expect(endFromWorkHours(start, hours, wh)).toBeNull();
  });

  // guards: BR-WO-040
  it.each([
    ['пт 10:00', at(FRI, '10:00'), 0.5],
    ['пт 17:00', at(FRI, '17:00'), 3],
    ['пт 09:00', at(FRI, '09:00'), 9],
    ['пт 16:30', at(FRI, '16:30'), 22.75],
    ['пн 12:00', at(MON, '12:00'), 40],
  ])(
    'взаємна з workHoursBetween: від %s за %s год і назад — ті самі години',
    (_l, start, hours) => {
      for (const wh of [MON_FRI, MON_SAT, DAILY_8_20]) {
        const end = endFromWorkHours(start, hours, wh)!;
        expect(workHoursBetween(start, end, wh)).toBe(hours);
      }
    },
  );
});

describe('slotWorkHours / slotEndFromWorkHours — нормогодини запису без наряду (дзеркало форми)', () => {
  // guards: BR-CAL-020
  it.each([
    ['той самий день — тривалість', at(FRI, '10:00'), at(FRI, '12:30'), MON_FRI, 2.5],
    [
      'початок до відкриття рахується (запис із 07:00)',
      at(FRI, '07:00'),
      at(FRI, '10:00'),
      MON_FRI,
      3,
    ],
    [
      'ланцюжок: пт до закриття + робочі години після',
      at(FRI, '17:00'),
      at(MON, '12:00'),
      MON_FRI,
      4,
    ],
    ['ланцюжок через робочу суботу', at(FRI, '16:00'), at(SUN, '10:00'), DAILY_8_20, 18],
    ['початок у вихідний — тривалість', at(SAT, '10:00'), at(MON, '12:00'), MON_FRI, 50],
    ['кінець не пізніше початку — 0', at(FRI, '12:00'), at(FRI, '12:00'), MON_FRI, 0],
    [
      'години після закриття — цілими хвилинами, як форма (1 хв, а не 0,02 год = 1,2 хв)',
      at(FRI, '17:59'),
      at(MON, '09:01'),
      MON_FRI,
      0.03,
    ],
  ])('%s', (_l, start, end, wh, hours) => {
    expect(slotWorkHours(start, end, wh)).toBe(hours);
  });

  // guards: BR-CAL-020
  it.each([
    ['у межах дня — «початок + тривалість»', at(FRI, '10:00'), 2, MON_FRI, at(FRI, '12:00')],
    ['за закриттям — на наступні робочі дні', at(FRI, '17:00'), 4, MON_FRI, at(MON, '12:00')],
    ['робоча субота', at(FRI, '17:00'), 4, MON_SAT, at(SAT, '12:00')],
    ['кілька днів', at(FRI, '16:00'), 18, MON_FRI, at(TUE, '16:00')],
    ['початок до відкриття — з запитаного часу', at(FRI, '07:00'), 3, MON_FRI, at(FRI, '10:00')],
    ['початок у вихідний — один запис', at(SAT, '10:00'), 3, MON_FRI, at(SAT, '13:00')],
    ['рівно до закриття — закриття того ж дня', at(FRI, '16:00'), 2, MON_FRI, at(FRI, '18:00')],
  ])('%s', (_l, start, hours, wh, end) => {
    expect(iso(slotEndFromWorkHours(start, hours, wh))).toBe(iso(end));
  });

  // guards: BR-CAL-020
  it('нуль годин чи невалідна дата → null', () => {
    expect(slotEndFromWorkHours(at(FRI, '10:00'), 0, MON_FRI)).toBeNull();
    expect(slotEndFromWorkHours(new Date('x'), 2, MON_FRI)).toBeNull();
  });

  // guards: BR-CAL-020
  it('пт 17–18 + пн 09–12 (4 год) на пн–пт → філія пн–сб: ті самі 4 год — пт + сб', () => {
    const hours = slotWorkHours(at(FRI, '17:00'), at(MON, '12:00'), MON_FRI);
    expect(iso(slotEndFromWorkHours(at(FRI, '17:00'), hours, MON_SAT))).toBe(iso(at(SAT, '12:00')));
  });
});

describe('sameWorkHours — чи перераховувати нормогодини при зміні філії', () => {
  // guards: BR-CAL-020, BR-WO-040
  it.each([
    [
      'ті самі години й дні',
      MON_FRI,
      { startHour: 9, endHour: 18, workDays: [5, 4, 3, 2, 1, 1] },
      true,
    ],
    ['без переліку днів — пн–пт', MON_FRI, { startHour: 9, endHour: 18 }, true],
    ['інші дні', MON_FRI, MON_SAT, false],
    ['інший початок', MON_FRI, { ...MON_FRI, startHour: 8 }, false],
    ['інше закриття', MON_FRI, { ...MON_FRI, endHour: 19 }, false],
  ])('%s → %s', (_l, a, b, same) => {
    expect(sameWorkHours(a, b)).toBe(same);
  });
});
