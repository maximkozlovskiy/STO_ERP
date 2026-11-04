import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { EMPLOYEE_CLEARABLE_FIELDS, employeeUpdateSchema } from './employee.schema';
import { GOOD_CLEARABLE_FIELDS, goodUpdateSchema } from './good.schema';
import { INVOICE_CLEARABLE_FIELDS, invoiceUpdateSchema } from './invoice.schema';
import {
  PURCHASE_ORDER_CLEARABLE_FIELDS,
  purchaseOrderUpdateSchema,
} from './purchase-order.schema';
import {
  STOCK_DOCUMENT_CLEARABLE_FIELDS,
  stockDocumentUpdateSchema,
} from './stock-document.schema';
import {
  SUPPLIER_RETURN_CLEARABLE_FIELDS,
  supplierReturnUpdateSchema,
} from './supplier-return.schema';
import { VEHICLE_CLEARABLE_FIELDS, vehicleUpdateSchema } from './vehicle.schema';
import {
  WORK_ORDER_CLEARABLE_FIELDS,
  workOrderLineUpdateSchema,
  workOrderUpdateSchema,
} from './work-order.schema';

// TECH-DEBT (а) 2026-11-01: очищене у картці поле → PATCH 200 → у БД старе значення. PATCH-схеми
// брали `optionalString` ('' і null → undefined), тож «очистити» не відрізнялось від «не чіпати».
// Мутація: повернути `optionalString()` будь-якому полю з переліку → його кейси '' / null червоніють.
const CASES: ReadonlyArray<[string, z.ZodType, readonly string[]]> = [
  ['vehicleUpdateSchema', vehicleUpdateSchema, VEHICLE_CLEARABLE_FIELDS],
  ['goodUpdateSchema', goodUpdateSchema, GOOD_CLEARABLE_FIELDS],
  ['employeeUpdateSchema', employeeUpdateSchema, EMPLOYEE_CLEARABLE_FIELDS],
  ['workOrderUpdateSchema', workOrderUpdateSchema, WORK_ORDER_CLEARABLE_FIELDS],
  ['workOrderLineUpdateSchema', workOrderLineUpdateSchema, ['notes']],
  ['invoiceUpdateSchema', invoiceUpdateSchema, INVOICE_CLEARABLE_FIELDS],
  ['purchaseOrderUpdateSchema', purchaseOrderUpdateSchema, PURCHASE_ORDER_CLEARABLE_FIELDS],
  ['stockDocumentUpdateSchema', stockDocumentUpdateSchema, STOCK_DOCUMENT_CLEARABLE_FIELDS],
  ['supplierReturnUpdateSchema', supplierReturnUpdateSchema, SUPPLIER_RETURN_CLEARABLE_FIELDS],
];

/** Значення числових полів: рядок з форми → число. Решта полів бере '2026-11-04' (текст і дати). */
const SAMPLE: Record<string, [string, unknown]> = {
  year: ['2015', 2015],
  engineVolume: ['1.6', 1.6],
  currentMileage: ['120000', 120000],
};

const parse = (schema: z.ZodType, body: object): Record<string, unknown> =>
  schema.parse(body) as Record<string, unknown>;

describe.each(CASES)('%s — очищення полів', (_name, schema, fields) => {
  it.each(fields.map(f => [f]))("%s: '' → null (очистити)", field => {
    expect(parse(schema, { [field]: '' })[field]).toBeNull();
  });

  it.each(fields.map(f => [f]))('%s: null → null (очистити)', field => {
    expect(parse(schema, { [field]: null })[field]).toBeNull();
  });

  it.each(fields.map(f => [f]))('%s: значення → як є', field => {
    // Дати (працівника, авто, термін рахунку) — рядки YYYY-MM-DD; сервіс сам перетворює їх на Date.
    const [input, expected] = SAMPLE[field] ?? ['2026-11-04', '2026-11-04'];
    expect(parse(schema, { [field]: input })[field]).toBe(expected);
  });

  it('ключа немає → ключа немає (поле не чіпається)', () => {
    const out = parse(schema, {});
    for (const field of fields) expect(field in out).toBe(false);
  });
});

describe('goodUpdateSchema — unit і barcode НЕ очищаються', () => {
  // `unit` — NOT NULL (типово «шт»): null у PATCH дав би 500. `barcode` картка не шле —
  // штрихкоди мають свою вкладку; null тут стер би їх з картки, де поля немає.
  it.each([['unit'], ['barcode']])("%s: '' і null → undefined (Prisma поле не чіпає)", field => {
    expect(parse(goodUpdateSchema, { [field]: '' })[field]).toBeUndefined();
    expect(parse(goodUpdateSchema, { [field]: null })[field]).toBeUndefined();
  });

  it('переліки GOOD_CLEARABLE_FIELDS не містять unit і barcode', () => {
    expect(GOOD_CLEARABLE_FIELDS).not.toContain('unit');
    expect(GOOD_CLEARABLE_FIELDS).not.toContain('barcode');
  });
});

// TECH-DEBT (а) 2026-11-04: нетекстові поля. Очищення не знімає меж — число й дата валідуються так
// само, як при створенні. Мутація: `clearableNumber(z.coerce.number())` без меж → кейси червоніють.
describe('vehicleUpdateSchema — числа й дати очищаються, але межі лишаються', () => {
  it.each([
    ['year', '1899'],
    ['year', '2015.5'],
    ['engineVolume', '-0.1'],
    ['currentMileage', '-1'],
    ['currentMileage', '10.5'],
    ['insuranceExpiry', 'not-a-date'],
    ['inspectionExpiry', '2026-02-31'],
  ])('%s = %s → помилка валідації', (field, value) => {
    expect(vehicleUpdateSchema.safeParse({ [field]: value }).success).toBe(false);
  });

  it('пробіг 0 — значення, не очищення', () => {
    expect(parse(vehicleUpdateSchema, { currentMileage: '0' }).currentMileage).toBe(0);
  });
});

describe('documentDate — NOT NULL, не очищається', () => {
  // Колонка `@default(now()) @db.Date`: null у PATCH дав би помилку Prisma. '' / null → undefined.
  it.each([
    ['invoiceUpdateSchema', invoiceUpdateSchema],
    ['stockDocumentUpdateSchema', stockDocumentUpdateSchema],
    ['supplierReturnUpdateSchema', supplierReturnUpdateSchema],
  ] as const)("%s: '' і null → undefined", (_name, schema) => {
    expect(parse(schema, { documentDate: '' }).documentDate).toBeUndefined();
    expect(parse(schema, { documentDate: null }).documentDate).toBeUndefined();
  });

  it('переліки *_CLEARABLE_FIELDS не містять documentDate', () => {
    for (const fields of [
      INVOICE_CLEARABLE_FIELDS,
      STOCK_DOCUMENT_CLEARABLE_FIELDS,
      SUPPLIER_RETURN_CLEARABLE_FIELDS,
    ] as ReadonlyArray<readonly string[]>)
      expect(fields).not.toContain('documentDate');
  });
});
