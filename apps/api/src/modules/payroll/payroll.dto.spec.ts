/**
 * DTO зарплати — дати періоду лише календарні (`РРРР-ММ-ДД`).
 *
 * `from` / `to` (попередній розрахунок) і `periodStart` / `periodEnd` (створення періоду) далі
 * стають межами київської доби (`normalizeKyivDateRange`). Голий `@IsDateString()` пропускав
 * ISO з часом (`2026-09-01T10:00:00Z` → `Invalid Date` після склейки з `T00:00:00`) і рік 0000.
 * Тепер форму тримає `@Matches(CALENDAR_DATE_RE)`, існування дня — `@IsDateString({ strict })`.
 *
 * Mutation-verify (2026-10-09): прибрати `@Matches(CALENDAR_DATE_RE)` → падають обидва кейси
 * «ISO з часом»; прибрати `{ strict: true }` → падають «неіснуюча дата» і «29 лютого
 * невисокосного року». Рік 0000, порожнє й сміття відхиляє кожен із двох декораторів окремо,
 * тож ці кейси падають лише коли прибрати обидва.
 */
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePayrollPeriodDto, PayrollQueryDto } from './payroll.dto';

const failedProps = async (cls: new () => object, plain: Record<string, unknown>) => {
  const errors = await validate(plainToInstance(cls, plain), { whitelist: true });
  return errors.map(e => e.property).sort();
};

const BAD_DATES = [
  ['неіснуюча дата', '2026-02-31'],
  ['неіснуючий місяць', '2026-13-01'],
  ['29 лютого невисокосного року', '2025-02-29'],
  ['ISO з часом', '2026-09-01T10:00:00Z'],
  ['ISO з часом і мілісекундами', '2026-09-01T00:00:00.000Z'],
  ['рік 0000', '0000-01-01'],
  ['порожній рядок', ''],
  ['день без нуля', '2026-9-1'],
  ['локальний формат', '01.09.2026'],
  ['сміття', 'abc'],
] as const;

describe('PayrollQueryDto — from / to', () => {
  it('календарні дати проходять', async () => {
    expect(await failedProps(PayrollQueryDto, { from: '2026-09-01', to: '2026-09-30' })).toEqual(
      [],
    );
    expect(await failedProps(PayrollQueryDto, { from: '2024-02-29', to: '2024-02-29' })).toEqual(
      [],
    );
  });

  it.each(BAD_DATES)('from: %s (%s) → помилка валідації', async (_name, value) => {
    expect(await failedProps(PayrollQueryDto, { from: value, to: '2026-09-30' })).toEqual(['from']);
  });

  it.each(BAD_DATES)('to: %s (%s) → помилка валідації', async (_name, value) => {
    expect(await failedProps(PayrollQueryDto, { from: '2026-09-01', to: value })).toEqual(['to']);
  });

  it('обидві дати обовʼязкові: без них — помилка по кожній', async () => {
    expect(await failedProps(PayrollQueryDto, {})).toEqual(['from', 'to']);
  });

  it('повторений параметр (масив) → помилка валідації', async () => {
    expect(
      await failedProps(PayrollQueryDto, { from: ['2026-09-01', '2026-09-02'], to: '2026-09-30' }),
    ).toEqual(['from']);
  });
});

describe('CreatePayrollPeriodDto — periodStart / periodEnd', () => {
  it('календарні дати проходять', async () => {
    expect(
      await failedProps(CreatePayrollPeriodDto, {
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
      }),
    ).toEqual([]);
  });

  it.each(BAD_DATES)('periodStart: %s (%s) → помилка валідації', async (_name, value) => {
    expect(
      await failedProps(CreatePayrollPeriodDto, { periodStart: value, periodEnd: '2026-09-30' }),
    ).toEqual(['periodStart']);
  });

  it.each(BAD_DATES)('periodEnd: %s (%s) → помилка валідації', async (_name, value) => {
    expect(
      await failedProps(CreatePayrollPeriodDto, { periodStart: '2026-09-01', periodEnd: value }),
    ).toEqual(['periodEnd']);
  });

  it('обидві дати обовʼязкові: без них — помилка по кожній', async () => {
    expect(await failedProps(CreatePayrollPeriodDto, {})).toEqual(['periodEnd', 'periodStart']);
  });
});
