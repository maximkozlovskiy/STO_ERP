/**
 * assertCalendarDateQuery — дати відбору з query-рядка без DTO (каса, оплати, рухи складу).
 *
 * code-review 2026-10-09: перевірка стояла лише в касі. В оплатах і рухах `2026-02-31` мовчки
 * «перекочувалось» у березень (список за іншим днем, ніж просили), а сміття давало безіменну
 * відмову Prisma.
 *
 * Mutation-verify: прибрати `!isCalendarDate(value)` → кейси «неіснуюча» і «сміття» падають;
 * прибрати гілку `typeof value !== 'string'` → кейс «масив» падає.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';

vi.mock('../tenant/tenant-context', () => ({ getLocale: () => 'uk' }));

import { assertCalendarDateQuery } from './date-query';

describe('assertCalendarDateQuery', () => {
  it('існуючі дати і порожні значення проходять', () => {
    expect(() => assertCalendarDateQuery('2026-10-09', '2024-02-29')).not.toThrow();
    expect(() => assertCalendarDateQuery(undefined, '')).not.toThrow();
    expect(() => assertCalendarDateQuery()).not.toThrow();
  });

  it.each(['2026-02-31', '2026-13-01', '2025-02-29'])(
    'неіснуюча дата %s → 400, а не «перекочування» на інший день',
    value => {
      expect(() => assertCalendarDateQuery('2026-01-01', value)).toThrow(BadRequestException);
    },
  );

  it.each(['abc', '09.10.2026', '2026-10-09T10:00:00Z', '2026-10-9'])(
    'не формат РРРР-ММ-ДД (%s) → 400',
    value => {
      expect(() => assertCalendarDateQuery(value)).toThrow(BadRequestException);
    },
  );

  it('повторений параметр (масив) → 400, без TypeError', () => {
    expect(() => assertCalendarDateQuery(['2026-10-09', '2026-10-10'])).toThrow(
      BadRequestException,
    );
  });

  it('повідомлення — українською, без назви модуля', () => {
    try {
      assertCalendarDateQuery('abc');
      expect.unreachable();
    } catch (e) {
      expect((e as BadRequestException).message).toMatch(/Невірна дата у відборі/);
    }
  });
});
