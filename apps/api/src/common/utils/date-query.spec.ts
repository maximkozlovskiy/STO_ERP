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

import { assertCalendarDateQuery, assertRequiredCalendarDateQuery } from './date-query';

/**
 * assertRequiredCalendarDateQuery — ОБОВ'ЯЗКОВІ межі періоду (звіти): на відміну від
 * assertCalendarDateQuery, відсутнє й порожнє значення — теж 400.
 *
 * Mutation-verify (2026-10-09): прибрати `!isCalendarDate(value)` → падають «порожня» і всі
 * «некалендарне значення». Гілка `typeof value !== 'string'` — еквівалентний мутант: без неї
 * не-рядок усе одно відхиляє `isCalendarDate` (регулярка зводить значення до рядка, а кінцеве
 * `=== value` для не-рядка завжди false), тож кейси «відсутня» й «масив» лишаються зеленими.
 * Вони стережуть поведінку (400, не TypeError), а не саму гілку.
 */
describe('assertRequiredCalendarDateQuery', () => {
  it('дві існуючі дати проходять', () => {
    expect(() => assertRequiredCalendarDateQuery('2026-10-01', '2026-10-09')).not.toThrow();
    expect(() => assertRequiredCalendarDateQuery('2024-02-29', '2024-02-29')).not.toThrow();
  });

  it('відсутня дата (undefined) → 400: межа періоду обовʼязкова', () => {
    expect(() => assertRequiredCalendarDateQuery(undefined, '2026-10-09')).toThrow(
      BadRequestException,
    );
    expect(() => assertRequiredCalendarDateQuery('2026-10-01', undefined)).toThrow(
      BadRequestException,
    );
  });

  it('порожня дата → 400 (у необовʼязкових межах порожнє означало б «без межі»)', () => {
    expect(() => assertRequiredCalendarDateQuery('', '2026-10-09')).toThrow(BadRequestException);
    expect(() => assertRequiredCalendarDateQuery('2026-10-01', '')).toThrow(BadRequestException);
    // Контроль: необовʼязковий варіант те саме значення пропускає.
    expect(() => assertCalendarDateQuery('', '2026-10-09')).not.toThrow();
  });

  it('повторений параметр (масив) → 400, без TypeError', () => {
    expect(() =>
      assertRequiredCalendarDateQuery(['2026-10-01', '2026-10-02'], '2026-10-09'),
    ).toThrow(BadRequestException);
  });

  it.each(['2026-02-31', '0000-01-01', '2026-10-09T10:00:00Z', '2026-10-09T00:00:00.000Z', 'abc'])(
    'некалендарне значення %s → 400',
    value => {
      expect(() => assertRequiredCalendarDateQuery(value, '2026-10-09')).toThrow(
        BadRequestException,
      );
      expect(() => assertRequiredCalendarDateQuery('2026-01-01', value)).toThrow(
        BadRequestException,
      );
    },
  );

  it('повідомлення — те саме, що для необовʼязкових меж: «Невірна дата у відборі»', () => {
    try {
      assertRequiredCalendarDateQuery(undefined, undefined);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as BadRequestException).message).toMatch(/Невірна дата у відборі/);
    }
  });
});

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
