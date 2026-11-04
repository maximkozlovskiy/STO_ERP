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

const parse = (schema: z.ZodType, body: object): Record<string, unknown> =>
  schema.parse(body) as Record<string, unknown>;

describe.each(CASES)('%s — очищення текстових полів', (_name, schema, fields) => {
  it.each(fields.map(f => [f]))("%s: '' → null (очистити)", field => {
    expect(parse(schema, { [field]: '' })[field]).toBeNull();
  });

  it.each(fields.map(f => [f]))('%s: null → null (очистити)', field => {
    expect(parse(schema, { [field]: null })[field]).toBeNull();
  });

  it.each(fields.map(f => [f]))('%s: значення → як є', field => {
    // Дати співробітника — теж рядки (YYYY-MM-DD); сервіс сам перетворює їх на Date.
    expect(parse(schema, { [field]: '2026-11-04' })[field]).toBe('2026-11-04');
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
