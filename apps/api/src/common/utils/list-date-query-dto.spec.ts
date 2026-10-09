/**
 * Відбір «з дня / по день» у п'яти списках документів із `documentDate` (`@db.Date`): наряди,
 * рахунки, замовлення постачальнику, повернення постачальнику, оплати постачальнику.
 *
 * Bug #820: `dateFrom` / `dateTo` стояли під нестрогим `@IsDateString()`. `0000-01-01` доходив до
 * Postgres (року 0 там немає) і давав 500; `2026-02-31` JS перекочував у 03.03 — список мовчки
 * відбирався за іншим днем (200). Тепер форму тримає `@Matches(CALENDAR_DATE_RE)`, існування
 * дня — `@IsDateString({ strict: true })`, як у складських документах (Bug #817).
 *
 * Один файл на п'ять DTO: правило одне, а окремий спек у кожному модулі — п'ять копій таблиці.
 *
 * Mutation-verify (2026-10-09): повернути `@IsDateString()` без `@Matches` у будь-якому з п'яти
 * DTO → його кейси «рік 0000» і «неіснуюча дата» падають.
 */
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { WorkOrderQueryDto } from '../../modules/work-orders/work-orders.dto';
import { InvoiceQueryDto } from '../../modules/invoices/invoices.dto';
import { PurchaseOrderQueryDto } from '../../modules/purchase-orders/purchase-orders.dto';
import { SupplierReturnQueryDto } from '../../modules/supplier-returns/supplier-returns.dto';
import { SupplierPaymentQueryDto } from '../../modules/supplier-payments/supplier-payments.dto';

const failedProps = async (cls: new () => object, plain: Record<string, unknown>) => {
  const errors = await validate(plainToInstance(cls, plain), { whitelist: true });
  return errors.map(e => e.property).sort();
};

const DTOS = [
  ['наряди', WorkOrderQueryDto],
  ['рахунки', InvoiceQueryDto],
  ['замовлення постачальнику', PurchaseOrderQueryDto],
  ['повернення постачальнику', SupplierReturnQueryDto],
  ['оплати постачальнику', SupplierPaymentQueryDto],
] as const;

const BAD_DATES = [
  ['рік 0000', '0000-01-01'],
  ['неіснуюча дата', '2026-02-31'],
  ['29 лютого невисокосного року', '2025-02-29'],
  ['ISO з часом', '2026-10-01T00:00:00Z'],
  ['сміття', 'abc'],
] as const;

describe.each(DTOS)('відбір за датою документа — %s', (_name, Dto) => {
  it('календарні дати проходять, зокрема крайні роки 1000 і 9999', async () => {
    expect(await failedProps(Dto, { dateFrom: '2026-10-01', dateTo: '2026-10-09' })).toEqual([]);
    expect(await failedProps(Dto, { dateFrom: '1000-01-01', dateTo: '9999-12-31' })).toEqual([]);
  });

  // Строга перевірка class-validator не приймає роки до 1000 — відмова (400), а не 500.
  it('рік до 1000 (0001, 0099) → відмова, не помилка сервера', async () => {
    expect(await failedProps(Dto, { dateFrom: '0001-01-01', dateTo: '0099-12-31' })).toEqual([
      'dateFrom',
      'dateTo',
    ]);
  });

  it('порожня межа — «межі немає», не помилка', async () => {
    expect(await failedProps(Dto, { dateFrom: '', dateTo: '' })).toEqual([]);
    expect(await failedProps(Dto, {})).toEqual([]);
  });

  it.each(BAD_DATES)('%s → відмова на обох межах', async (_label, value) => {
    expect(await failedProps(Dto, { dateFrom: value })).toEqual(['dateFrom']);
    expect(await failedProps(Dto, { dateTo: value })).toEqual(['dateTo']);
  });

  it('повторений параметр (масив) → відмова', async () => {
    expect(await failedProps(Dto, { dateFrom: ['2026-10-01', '2026-10-02'] })).toEqual([
      'dateFrom',
    ]);
  });
});
