import { describe, it, expect } from 'vitest';
import { kyivDateTimeToISO, kyivOffsetMs } from './format';

/**
 * Regression-guard для Bug #354 — calendar slot creation парсила час як
 * local TZ браузера. Helper повинен повертати true UTC ISO незалежно від
 * того в якій TZ запущений Node/браузер.
 */
describe('kyivDateTimeToISO — DST-aware Kyiv → UTC (Bug #354)', () => {
  it('літня дата (EEST +03): 09:00 Kyiv → 06:00 UTC', () => {
    const iso = kyivDateTimeToISO('2026-06-05', '09:00');
    expect(iso).toBe('2026-06-05T06:00:00.000Z');
  });

  it('зимова дата (EET +02): 09:00 Kyiv → 07:00 UTC', () => {
    const iso = kyivDateTimeToISO('2026-01-15', '09:00');
    expect(iso).toBe('2026-01-15T07:00:00.000Z');
  });

  it('опівночі Kyiv: 00:00 → 22:00 UTC попереднього дня (літо)', () => {
    const iso = kyivDateTimeToISO('2026-06-05', '00:00');
    expect(iso).toBe('2026-06-04T21:00:00.000Z');
  });

  it('кінець дня Kyiv: 23:59 літо → 20:59 UTC того ж дня', () => {
    const iso = kyivDateTimeToISO('2026-06-05', '23:59');
    expect(iso).toBe('2026-06-05T20:59:00.000Z');
  });

  it('повертає порожній рядок для невалідної дати', () => {
    expect(kyivDateTimeToISO('invalid', '09:00')).toBe('');
    expect(kyivDateTimeToISO('2026-06-05', 'invalid')).toBe('');
  });
});

describe('kyivOffsetMs — DST-aware offset', () => {
  it('літо: +3 години', () => {
    expect(kyivOffsetMs(new Date('2026-07-15T12:00:00Z'))).toBe(3 * 3_600_000);
  });

  it('зима: +2 години', () => {
    expect(kyivOffsetMs(new Date('2026-01-15T12:00:00Z'))).toBe(2 * 3_600_000);
  });
});
