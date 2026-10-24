import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import {
  MONEY_AMOUNT_MAX,
  QTY_MAX,
  invoiceHeaderSchema,
  invoiceUpdateSchema,
  invoiceLineSchema,
  invoiceLineUpdateSchema,
  invoiceFormLineSchema,
  stockDocumentCreateSchema,
  stockDocumentUpdateSchema,
  supplierPaymentCreateSchema,
  supplierPaymentUpdateSchema,
  workOrderCreateSchema,
  workOrderUpdateSchema,
  workOrderLineSchema,
  workOrderLineUpdateSchema,
  workOrderPartSchema,
  workOrderPartUpdateSchema,
  workOrderFormLineSchema,
  workOrderFormPartSchema,
  workOrderFormSchema,
} from '@sto/shared';
import { ZodValidationPipe } from './zod-validation.pipe';
import { globalPipes } from './global-pipes';
import { StockItemsController } from '../../modules/inventory/stock-items.controller';

// ─── Стелі сум і кількостей (M3 безпекового блоку, 2026-10-24) ──────────────────────────────────
//
// Сума понад місткість `Decimal(12,2)` (9 999 999 999,99) доходила до бази й поверталась 500
// `numeric field overflow`; кількість і години — колонки `Float`, але кількість × ціна лягає в
// суму рядка, тож для них спільна стеля QTY_MAX. Маршрути цих документів валідують тіло
// ZodValidationPipe зі спільних схем — тест іде через ту саму трубу: понад стелю — 400, межа — ні.

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const MONEY = MONEY_AMOUNT_MAX;
const OVER_MONEY = 10_000_000_000;
const QTY = QTY_MAX;
const OVER_QTY = QTY_MAX + 0.001;

interface Case {
  name: string;
  schema: ZodSchema;
  /** Тіло з полем на межі (`at`) або понад неї (`over`). */
  body: (v: number) => Record<string, unknown>;
  cap: 'money' | 'qty';
}

const stockLine = (quantity: number, price: number) => ({
  type: 'WRITEOFF',
  branchId: U1,
  warehouseId: U2,
  lines: [{ goodId: U3, quantity, price }],
});

const CASES: Case[] = [
  // Рахунок
  {
    name: 'POST /invoices amount',
    schema: invoiceHeaderSchema,
    body: v => ({ counterpartyId: U1, amount: v }),
    cap: 'money',
  },
  {
    name: 'PATCH /invoices amount',
    schema: invoiceUpdateSchema,
    body: v => ({ amount: v }),
    cap: 'money',
  },
  {
    name: 'POST /invoices/:id/lines quantity',
    schema: invoiceLineSchema,
    body: v => ({ description: 'Робота', quantity: v, unitPrice: 1 }),
    cap: 'qty',
  },
  {
    name: 'POST /invoices/:id/lines unitPrice',
    schema: invoiceLineSchema,
    body: v => ({ description: 'Робота', quantity: 1, unitPrice: v }),
    cap: 'money',
  },
  {
    name: 'PATCH /invoices/:id/lines quantity',
    schema: invoiceLineUpdateSchema,
    body: v => ({ quantity: v }),
    cap: 'qty',
  },
  {
    name: 'PATCH /invoices/:id/lines unitPrice',
    schema: invoiceLineUpdateSchema,
    body: v => ({ unitPrice: v }),
    cap: 'money',
  },
  // Оплата постачальнику
  {
    name: 'POST /supplier-payments amount',
    schema: supplierPaymentCreateSchema,
    body: v => ({
      supplierId: U1,
      sourceType: 'BANK_ACCOUNT',
      bankAccountId: U2,
      amount: v,
      method: 'BANK',
    }),
    cap: 'money',
  },
  {
    name: 'PATCH /supplier-payments amount',
    schema: supplierPaymentUpdateSchema,
    body: v => ({ amount: v }),
    cap: 'money',
  },
  // Складський документ
  {
    name: 'POST /stock-documents lines[].quantity',
    schema: stockDocumentCreateSchema,
    body: v => stockLine(v, 1),
    cap: 'qty',
  },
  {
    name: 'POST /stock-documents lines[].price',
    schema: stockDocumentCreateSchema,
    body: v => stockLine(1, v),
    cap: 'money',
  },
  {
    name: 'PATCH /stock-documents lines[].quantity',
    schema: stockDocumentUpdateSchema,
    body: v => ({ lines: [{ goodId: U3, quantity: v }] }),
    cap: 'qty',
  },
  // Наряд: шапка
  {
    name: 'POST /work-orders plannedHours',
    schema: workOrderCreateSchema,
    body: v => ({ branchId: U1, vehicleId: U2, counterpartyId: U3, plannedHours: v }),
    cap: 'qty',
  },
  {
    name: 'PATCH /work-orders plannedHours',
    schema: workOrderUpdateSchema,
    body: v => ({ plannedHours: v }),
    cap: 'qty',
  },
  {
    name: 'PATCH /work-orders actualHours',
    schema: workOrderUpdateSchema,
    body: v => ({ actualHours: v }),
    cap: 'qty',
  },
  // Наряд: роботи
  {
    name: 'POST /work-orders/:id/lines normoHours',
    schema: workOrderLineSchema,
    body: v => ({ workId: U1, employeeId: U2, normoHours: v }),
    cap: 'qty',
  },
  {
    name: 'POST /work-orders/:id/lines actualHours',
    schema: workOrderLineSchema,
    body: v => ({ workId: U1, employeeId: U2, actualHours: v }),
    cap: 'qty',
  },
  {
    name: 'POST /work-orders/:id/lines price',
    schema: workOrderLineSchema,
    body: v => ({ workId: U1, employeeId: U2, price: v }),
    cap: 'money',
  },
  {
    name: 'PATCH /work-orders/:id/lines normoHours',
    schema: workOrderLineUpdateSchema,
    body: v => ({ normoHours: v }),
    cap: 'qty',
  },
  {
    name: 'PATCH /work-orders/:id/lines actualHours',
    schema: workOrderLineUpdateSchema,
    body: v => ({ actualHours: v }),
    cap: 'qty',
  },
  {
    name: 'PATCH /work-orders/:id/lines price',
    schema: workOrderLineUpdateSchema,
    body: v => ({ price: v }),
    cap: 'money',
  },
  // Наряд: запчастини
  {
    name: 'POST /work-orders/:id/parts quantity',
    schema: workOrderPartSchema,
    body: v => ({ goodId: U1, warehouseId: U2, quantity: v }),
    cap: 'qty',
  },
  {
    name: 'POST /work-orders/:id/parts price',
    schema: workOrderPartSchema,
    body: v => ({ goodId: U1, warehouseId: U2, quantity: 1, price: v }),
    cap: 'money',
  },
  {
    name: 'PATCH /work-orders/:id/parts quantity',
    schema: workOrderPartUpdateSchema,
    body: v => ({ quantity: v }),
    cap: 'qty',
  },
  {
    name: 'PATCH /work-orders/:id/parts price',
    schema: workOrderPartUpdateSchema,
    body: v => ({ price: v }),
    cap: 'money',
  },
];

const limits = (cap: Case['cap']) =>
  cap === 'money' ? { at: MONEY, over: OVER_MONEY } : { at: QTY, over: OVER_QTY };

describe('Стелі сум і кількостей — 400 через ZodValidationPipe маршруту', () => {
  it('стелі збігаються з колонкою і з текстом повідомлень (v.amountMax / v.qtyMax)', () => {
    // Decimal(12,2): 10 цифр до коми. Текст повідомлень називає обидва числа — міняти разом.
    expect(MONEY_AMOUNT_MAX).toBe(9_999_999_999.99);
    expect(QTY_MAX).toBe(1_000_000);
  });

  it.each(CASES)('$name: понад стелю — 400 з назвою поля', ({ schema, body, cap }) => {
    const pipe = new ZodValidationPipe(schema);
    let error: unknown;
    try {
      pipe.transform(body(limits(cap).over));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BadRequestException);
    const message = ((error as BadRequestException).getResponse() as { message: string[] })
      .message[0];
    // Оплата постачальнику має власний текст («Сума оплати завелика»), решта — спільні v.amountMax /
    // v.qtyMax із межею в тексті.
    expect(message).toMatch(
      cap === 'money' ? /^Сума (оплати )?завелика/ : /^Значення завелике — не більше 1 000 000/,
    );
    expect(message).toContain('(поле "');
  });

  it.each(CASES)('$name: значення на межі проходить', ({ schema, body, cap }) => {
    expect(() => new ZodValidationPipe(schema).transform(body(limits(cap).at))).not.toThrow();
  });
});

describe('Стелі сум і кількостей — форма web (та сама схема на клієнті)', () => {
  it.each([
    [
      'рахунок: рядок quantity',
      invoiceFormLineSchema,
      { description: 'X', quantity: OVER_QTY, unitPrice: 1 },
    ],
    [
      'рахунок: рядок unitPrice',
      invoiceFormLineSchema,
      { description: 'X', quantity: 1, unitPrice: OVER_MONEY },
    ],
    [
      'наряд: робота price («1,5» з комою)',
      workOrderFormLineSchema,
      { workId: U1, employeeId: U2, price: '10000000000,5' },
    ],
    [
      'наряд: робота normoHours',
      workOrderFormLineSchema,
      { workId: U1, employeeId: U2, normoHours: String(OVER_QTY) },
    ],
    [
      'наряд: запчастина quantity',
      workOrderFormPartSchema,
      { goodId: U1, warehouseId: U2, quantity: String(OVER_QTY) },
    ],
    [
      'наряд: запчастина price',
      workOrderFormPartSchema,
      { goodId: U1, warehouseId: U2, quantity: '1', price: String(OVER_MONEY) },
    ],
    [
      'наряд: планові години',
      workOrderFormSchema,
      { branchId: U1, vehicleId: U2, counterpartyId: U3, plannedHours: String(OVER_QTY) },
    ],
  ] as const)('%s понад стелю — помилка форми', (_name, schema, value) => {
    expect((schema as ZodSchema).safeParse(value).success).toBe(false);
  });
});

describe('Стеля мінімального залишку — PATCH /stock-items/:id/min-stock (class-validator)', () => {
  // Тип тіла беремо з метаданих маршруту — той самий клас, що бачить глобальний ValidationPipe.
  const paramTypes = Reflect.getMetadata(
    'design:paramtypes',
    StockItemsController.prototype,
    'updateMinStock',
  ) as (new () => object)[];
  const metatype = paramTypes.find(t => t.name === 'UpdateMinStockDto');
  const validation = globalPipes().find(p => p instanceof ValidationPipe) as ValidationPipe;

  const validate = (minStock: number) =>
    validation.transform({ minStock }, { type: 'body', metatype, data: undefined });

  it('тіло маршруту — UpdateMinStockDto', () => {
    expect(metatype).toBeDefined();
  });

  it('minStock понад QTY_MAX — 400', async () => {
    await expect(validate(OVER_QTY)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('minStock = QTY_MAX проходить', async () => {
    await expect(validate(QTY)).resolves.toEqual({ minStock: QTY });
  });
});
