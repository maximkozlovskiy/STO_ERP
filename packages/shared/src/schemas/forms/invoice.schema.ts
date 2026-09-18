import { z } from 'zod';
import { optionalString, optionalUuid, optionalDateString, moneyString } from '../validators';

/**
 * Спільні zod-схеми рахунку (Invoice) — ЄДИНЕ джерело правди web ↔ api.
 *
 * АРХІТЕКТУРНА ОСОБЛИВІСТЬ: line-items НЕ у тілі POST /invoices — бек створює лише шапку, рядки
 * додаються окремими POST /invoices/:id/lines. Тому:
 *  · `invoiceHeaderSchema`/`invoiceUpdateSchema` — валідують ШАПКУ (бек-pipe на create/update).
 *  · `invoiceLineSchema`/`invoiceLineUpdateSchema` — валідують РЯДОК (бек-pipe на /lines).
 *  · `invoiceFormSchema` — форма web (шапка + `lines: z.array`), валідується RHF+useFieldArray;
 *    submit лишається multi-request (POST шапка → N× POST /lines → DELETE видалених).
 *
 * invoiceType — вільний рядок на беку; UI-значення STANDARD/PREPAYMENT/CREDIT_NOTE (INVOICE_TYPE_LABELS).
 * Дати dueDate/documentDate — optionalDateString (дзеркалить @IsDateString; без нього битий рядок → 500).
 */

export const INVOICE_TYPE_VALUES = ['STANDARD', 'PREPAYMENT', 'CREDIT_NOTE'] as const;
export type InvoiceTypeValue = (typeof INVOICE_TYPE_VALUES)[number];

// ─── Рядок рахунку (POST/PATCH /invoices/:id/lines) ──────────────────────────
const invoiceLineShape = {
  description: z
    .string()
    .trim()
    .min(1, 'v.invoice.line.description.required')
    .max(500, 'v.invoice.line.description.max'),
  // moneyString (UA-кома-aware): endpoint отримує numeric JSON (проходить), backstop для '1,5'.
  quantity: moneyString().pipe(z.number().min(0.001, 'v.invoice.line.quantity.min')),
  unitPrice: moneyString().pipe(z.number().min(0, 'v.invoice.line.unitPrice.nonNeg')),
  vatRate: z.preprocess(
    v => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z
      .number()
      .min(0, 'v.invoice.line.vatRate.nonNeg')
      .max(100, 'v.invoice.line.vatRate.max')
      .optional(),
  ),
  goodId: optionalUuid(),
  workId: optionalUuid(),
  unitOfMeasureId: optionalUuid(),
  sortOrder: z.preprocess(
    v => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z.number().int().min(0).optional(),
  ),
};

export const invoiceLineSchema = z.object(invoiceLineShape);
export type InvoiceLineValues = z.infer<typeof invoiceLineSchema>;

export const invoiceLineUpdateSchema = z.object(invoiceLineShape).partial();
export type InvoiceLineUpdateValues = z.infer<typeof invoiceLineUpdateSchema>;

// ─── Шапка рахунку (POST /invoices) ──────────────────────────────────────────
export const invoiceHeaderSchema = z.object({
  counterpartyId: z.string().uuid('v.invoice.counterparty.required'),
  workOrderId: optionalUuid(),
  // amount обчислює фронт (сума рядків); бек-мінімум 0.01 (дзеркалить @Min(0.01)).
  amount: moneyString().pipe(z.number().min(0.01, 'v.invoice.amount.min')),
  invoiceType: z.preprocess(
    v => (v === '' || v === null ? undefined : v),
    z.enum(INVOICE_TYPE_VALUES).optional(),
  ),
  dueDate: optionalDateString(),
  documentDate: optionalDateString(),
  currencyId: optionalUuid(),
  notes: optionalString(),
});
export type InvoiceHeaderValues = z.infer<typeof invoiceHeaderSchema>;

export const invoiceUpdateSchema = invoiceHeaderSchema.partial();
export type InvoiceUpdateValues = z.infer<typeof invoiceUpdateSchema>;

// ─── Форма web (шапка + line-items) ──────────────────────────────────────────
// Форма НЕ вводить amount (обчислюється зі суми рядків) — тому тут його немає; при submit фронт
// рахує amount і додає у header-payload. Рядок форми — description/quantity/unitPrice (як зараз у UI).
export const invoiceFormLineSchema = z.object({
  // _key/id — локальні RHF-поля (стабільний ключ / серверний id рядка) — не валідуються схемою даних.
  _key: z.string().optional(),
  id: z.string().optional(),
  description: z.string().trim().min(1, 'v.invoice.line.description.required').max(500),
  // moneyString (не numericString): UA-кома-aware backstop — інпут вільний рядок; хоча зараз
  // type=number блокує кому в браузері, це захищає програмні/Excel-значення (Number('1,5')=NaN інакше).
  quantity: moneyString().pipe(z.number().min(0.001, 'v.invoice.line.quantity.min')),
  unitPrice: moneyString().pipe(z.number().min(0, 'v.invoice.line.unitPrice.nonNeg')),
});

export const invoiceFormSchema = z.object({
  counterpartyId: z.string().uuid('v.invoice.counterparty.required'),
  invoiceType: z.preprocess(
    v => (v === '' || v === null ? undefined : v),
    z.enum(INVOICE_TYPE_VALUES).optional(),
  ),
  currencyId: optionalUuid(),
  dueDate: optionalDateString(),
  documentDate: optionalDateString(),
  notes: optionalString(),
  lines: z.array(invoiceFormLineSchema).default([]),
});
export type InvoiceFormValues = z.infer<typeof invoiceFormSchema>;
export type InvoiceFormInput = z.input<typeof invoiceFormSchema>;
