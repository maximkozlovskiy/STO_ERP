import { describe, it, expect } from 'vitest';
import {
  kyivDateTimeToISO,
  kyivOffsetMs,
  isoToKyivLocalDateTime,
  localDateTimeToISO,
} from './format';

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

/**
 * Bug #436 (Cycle 3): localDateTimeToISO + isoToKyivLocalDateTime витягнуті у format.ts
 * у refactor 4a70b0f9. Активно вживаються у CreateWorkOrderModal (POST/PATCH normalize,
 * edit-mode load, conflict-check) — DST-aware + pass-through fast-path логіка без
 * тестів = silent regression при майбутніх refactor.
 */
describe('localDateTimeToISO — naive Kyiv local → UTC ISO (Bug #436)', () => {
  it('порожній рядок → undefined (для optional API fields)', () => {
    expect(localDateTimeToISO('')).toBeUndefined();
  });

  it('літня дата (EEST +03): 2026-06-10T19:00 Kyiv → 2026-06-10T16:00:00.000Z', () => {
    expect(localDateTimeToISO('2026-06-10T19:00')).toBe('2026-06-10T16:00:00.000Z');
  });

  it('зимова дата (EET +02): 2026-01-15T09:00 Kyiv → 2026-01-15T07:00:00.000Z', () => {
    expect(localDateTimeToISO('2026-01-15T09:00')).toBe('2026-01-15T07:00:00.000Z');
  });

  it('pass-through Z-suffix: 2026-06-10T16:00:00.000Z → unchanged', () => {
    expect(localDateTimeToISO('2026-06-10T16:00:00.000Z')).toBe('2026-06-10T16:00:00.000Z');
  });

  it('pass-through ±HH:MM offset: 2026-06-10T19:00:00+03:00 → unchanged', () => {
    expect(localDateTimeToISO('2026-06-10T19:00:00+03:00')).toBe('2026-06-10T19:00:00+03:00');
  });

  it('pass-through ±HHMM (no colon): 2026-06-10T19:00:00+0300 → unchanged', () => {
    expect(localDateTimeToISO('2026-06-10T19:00:00+0300')).toBe('2026-06-10T19:00:00+0300');
  });

  it('без T-сепаратора → undefined (date-only)', () => {
    expect(localDateTimeToISO('2026-06-10')).toBeUndefined();
  });

  it('невалідна дата → undefined', () => {
    expect(localDateTimeToISO('not-a-date')).toBeUndefined();
  });
});

describe('isoToKyivLocalDateTime — UTC ISO → Kyiv local (Bug #436)', () => {
  it('null/undefined/порожній → ""', () => {
    expect(isoToKyivLocalDateTime(null)).toBe('');
    expect(isoToKyivLocalDateTime(undefined)).toBe('');
    expect(isoToKyivLocalDateTime('')).toBe('');
  });

  it('літо: 2026-06-12T05:30:00.000Z UTC → 2026-06-12T08:30 Kyiv (+3)', () => {
    expect(isoToKyivLocalDateTime('2026-06-12T05:30:00.000Z')).toBe('2026-06-12T08:30');
  });

  it('зима: 2026-01-15T07:00:00.000Z UTC → 2026-01-15T09:00 Kyiv (+2)', () => {
    expect(isoToKyivLocalDateTime('2026-01-15T07:00:00.000Z')).toBe('2026-01-15T09:00');
  });

  it('невалідна дата → ""', () => {
    expect(isoToKyivLocalDateTime('not-a-date')).toBe('');
  });

  it('round-trip: localDateTimeToISO(isoToKyivLocalDateTime(iso)) === iso для valid літа', () => {
    const iso = '2026-06-12T05:30:00.000Z';
    const local = isoToKyivLocalDateTime(iso);
    expect(localDateTimeToISO(local)).toBe(iso);
  });

  it('round-trip: те саме для зими', () => {
    const iso = '2026-01-15T07:00:00.000Z';
    const local = isoToKyivLocalDateTime(iso);
    expect(localDateTimeToISO(local)).toBe(iso);
  });
});
