// «Виручка за 7 днів» — усі сім днів, порожні нулем (UX-огляд 2026-10-29: графік показував лише
// дні з виручкою). Mutation-verify: повертати лише `rows` → падає перший кейс.
import { describe, it, expect } from 'vitest';
import { fillRevenueWeek } from '../revenue-week';

describe('fillRevenueWeek', () => {
  it('сім днів до сьогодні включно, у порядку дат; без виручки — 0', () => {
    const week = fillRevenueWeek(
      [
        { date: '2026-10-29', revenue: 500, count: 2 },
        { date: '2026-10-25', revenue: 100, count: 1 },
      ],
      '2026-10-29',
    );
    expect(week.map(d => d.date)).toEqual([
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
    ]);
    expect(week.map(d => d.revenue)).toEqual([0, 0, 100, 0, 0, 0, 500]);
  });

  it('межа місяця й переведення годинника (25.10) не губить і не дублює день', () => {
    const week = fillRevenueWeek([], '2026-11-01');
    expect(week.map(d => d.date)).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ]);
  });

  it('рядки поза тижнем відкидаються; той самий день — складається', () => {
    const week = fillRevenueWeek(
      [
        { date: '2026-10-01', revenue: 999, count: 9 },
        { date: '2026-10-29', revenue: 10, count: 1 },
        { date: '2026-10-29T00:00:00.000Z', revenue: 5, count: 1 },
      ],
      '2026-10-29',
    );
    expect(week.reduce((s, d) => s + d.revenue, 0)).toBe(15);
    expect(week[6]).toEqual({ date: '2026-10-29', revenue: 15, count: 2 });
  });
});
