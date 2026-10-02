import { z } from 'zod';
import {
  optionalString,
  optionalUuid,
  optionalDateString,
  moneyString,
  optionalMoneyNumber,
} from '../validators';

/**
 * Спільна zod-схема складського документа (StockDocument) — ЄДИНЕ джерело правди web ↔ api.
 *
 * Крос-польове правило TRANSFER (Bug #462) раніше жило ЛИШЕ у service (BadRequest):
 * type===TRANSFER → targetWarehouseId обовʼязковий І ≠ warehouseId. Тепер у superRefine
 * (per-field помилка на targetWarehouseId). Бек-service guard лишається як defense-in-depth.
 *
 * Рядки (lines) йдуть У ТІЛІ create/update (атомарний $transaction на беку), БЕЗ окремого
 * /lines-endpoint — тому звичайний RHF-масив у payload, без multi-request retry (на відміну
 * від Invoice). price опційна (@Min(0)); quantity обовʼязкова (@Min(0.001)).
 */

// Prisma enum StockDocumentType — WRITEOFF/TRANSFER/OPENING_BALANCE/RECEIPT.
export const STOCK_DOCUMENT_TYPE_VALUES = [
  'WRITEOFF',
  'TRANSFER',
  'OPENING_BALANCE',
  'RECEIPT',
] as const;
export type StockDocumentTypeValue = (typeof STOCK_DOCUMENT_TYPE_VALUES)[number];

// Рядок документа: goodId(uuid) + quantity(≥0.001) + price?(≥0). Дзеркалить StockDocumentLineDto.
export const stockDocumentLineSchema = z.object({
  goodId: z.string().uuid('v.stockDocument.line.good.required'),
  // moneyString/optionalMoneyNumber (UA-кома backstop) замість numericString/optionalNonNegNumber:
  // захищає програмні/Excel-значення '1,5' (Number('1,5')=NaN інакше). Numeric JSON з фронта проходить.
  quantity: moneyString().pipe(z.number().min(0.001, 'v.stockDocument.line.quantity.min')),
  price: optionalMoneyNumber(),
});
export type StockDocumentLineInput = z.input<typeof stockDocumentLineSchema>;
export type StockDocumentLineValues = z.infer<typeof stockDocumentLineSchema>;

const stockDocumentShape = {
  type: z.enum(STOCK_DOCUMENT_TYPE_VALUES, {
    error: 'v.stockDocument.type.required',
  }),
  branchId: z.string().uuid('v.stockDocument.branch.required'),
  warehouseId: z.string().uuid('v.stockDocument.warehouse.required'),
  targetWarehouseId: optionalUuid(),
  purchaseOrderId: optionalUuid(),
  notes: optionalString(),
  documentDate: optionalDateString(),
  lines: z.array(stockDocumentLineSchema).default([]),
};

// Крос-польова перевірка TRANSFER (дзеркалить service guard, Bug #462).
const transferRefine = (
  v: {
    type: string;
    warehouseId?: string | undefined;
    targetWarehouseId?: string | undefined;
  },
  ctx: z.RefinementCtx,
) => {
  if (v.type === 'TRANSFER') {
    if (!v.targetWarehouseId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetWarehouseId'],
        message: 'v.stockDocument.transfer.targetRequired',
      });
    } else if (v.targetWarehouseId === v.warehouseId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetWarehouseId'],
        message: 'v.stockDocument.transfer.targetSame',
      });
    }
  }
};

export const stockDocumentFormSchema = z.object(stockDocumentShape).superRefine(transferRefine);
export type StockDocumentFormValues = z.infer<typeof stockDocumentFormSchema>;
export type StockDocumentFormInput = z.input<typeof stockDocumentFormSchema>;

// Бек create = форма (той самий TRANSFER superRefine).
export const stockDocumentCreateSchema = stockDocumentFormSchema;
export type StockDocumentCreateValues = StockDocumentFormValues;

// Update — лише notes/documentDate/lines (type/branch/warehouse незмінні після створення;
// service дозволяє редагувати лише DRAFT і не приймає зміну type). Cross-field TRANSFER
// не рефайнимо тут — targetWarehouse фіксований з create.
export const stockDocumentUpdateSchema = z.object({
  notes: optionalString(),
  documentDate: optionalDateString(),
  lines: z.array(stockDocumentLineSchema).optional(),
});
export type StockDocumentUpdateValues = z.infer<typeof stockDocumentUpdateSchema>;
