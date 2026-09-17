import { z } from 'zod';
import { optionalString, optionalUuid, optionalDateString, moneyString } from '../validators';

/**
 * Спільна zod-схема повернення постачальнику (SupplierReturn) — ЄДИНЕ джерело правди web ↔ api.
 *
 * Рядки (lines) йдуть У ТІЛІ create/update (атомарний $transaction на беку), БЕЗ окремого
 * /lines-endpoint — звичайний RHF-масив у payload, без multi-request retry (на відміну від Invoice).
 * price ОБОВʼЯЗКОВА (@IsNumber @Min(0), без @IsOptional) — на відміну від StockDocument.
 * purchaseOrderId — лише при CREATE (update-схема його не містить, дзеркалить UpdateSupplierReturnDto).
 */

// Рядок повернення: goodId(uuid) + quantity(≥0.001) + price(≥0, обовʼязкова) + unitOfMeasureId?.
export const supplierReturnLineSchema = z.object({
  goodId: z.string().uuid('Оберіть товар'),
  // moneyString (UA-кома backstop) замість numericString — захищає програмні/Excel-значення '1,5'.
  quantity: moneyString().pipe(z.number().min(0.001, 'Кількість повинна бути більшою за нуль')),
  price: moneyString().pipe(z.number().min(0, "Ціна не може бути від'ємною")),
  unitOfMeasureId: optionalUuid(),
});
export type SupplierReturnLineInput = z.input<typeof supplierReturnLineSchema>;
export type SupplierReturnLineValues = z.infer<typeof supplierReturnLineSchema>;

const supplierReturnBaseShape = {
  supplierId: z.string().uuid('Оберіть постачальника'),
  warehouseId: z.string().uuid('Оберіть склад'),
  notes: optionalString(),
  documentDate: optionalDateString(),
  lines: z.array(supplierReturnLineSchema).default([]),
};

// Форма/create: base + purchaseOrderId (create-only).
export const supplierReturnFormSchema = z.object({
  ...supplierReturnBaseShape,
  purchaseOrderId: optionalUuid(),
});
export type SupplierReturnFormValues = z.infer<typeof supplierReturnFormSchema>;
export type SupplierReturnFormInput = z.input<typeof supplierReturnFormSchema>;

export const supplierReturnCreateSchema = supplierReturnFormSchema;
export type SupplierReturnCreateValues = SupplierReturnFormValues;

// Update — supplierId/warehouseId опційні, notes/documentDate/lines; БЕЗ purchaseOrderId.
export const supplierReturnUpdateSchema = z.object({
  supplierId: optionalUuid(),
  warehouseId: optionalUuid(),
  notes: optionalString(),
  documentDate: optionalDateString(),
  lines: z.array(supplierReturnLineSchema).optional(),
});
export type SupplierReturnUpdateValues = z.infer<typeof supplierReturnUpdateSchema>;
