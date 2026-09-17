import { z } from 'zod';
import {
  optionalString,
  optionalUuid,
  optionalDateString,
  moneyString,
  optionalMoneyNumber,
} from '../validators';

/**
 * Спільна zod-схема покупкового ордера (PurchaseOrder) — ЄДИНЕ джерело правди web ↔ api.
 *
 * Рядки (lines) йдуть У ТІЛІ create/update (атомарний $transaction на беку, Bug #460),
 * БЕЗ окремого /lines-endpoint — звичайний RHF-масив у payload, без multi-request retry.
 * price ОБОВʼЯЗКОВА (@Min(0)); pricedSalePrice опційна (@Min(0)).
 *
 * receive/apply-pricing/transition мають ОКРЕМІ DTO (ReceivePurchaseOrderDto тощо) — не тут.
 *
 * Update: contractId/trackingNumber nullable (null/"" → очистити; UUID/рядок → встановити;
 * undefined → не чіпати) — дзеркалить UpdatePurchaseOrderDto @ValidateIf(value !== null).
 */

// Рядок ордера: goodId(uuid) + quantity(≥0.001) + price(≥0, обовʼязкова) + pricedSalePrice?(≥0).
export const purchaseOrderLineSchema = z.object({
  goodId: z.string().uuid('Оберіть товар'),
  // moneyString/optionalMoneyNumber (UA-кома backstop) замість numericString/optionalNonNegNumber —
  // захищає програмні/Excel-значення '1,5' (Number('1,5')=NaN інакше). Numeric JSON з фронта проходить.
  quantity: moneyString().pipe(z.number().min(0.001, 'Кількість повинна бути більшою за нуль')),
  price: moneyString().pipe(z.number().min(0, "Ціна не може бути від'ємною")),
  pricedSalePrice: optionalMoneyNumber(),
});
export type PurchaseOrderLineInput = z.input<typeof purchaseOrderLineSchema>;
export type PurchaseOrderLineValues = z.infer<typeof purchaseOrderLineSchema>;

// trackingNumber: '' → undefined, інакше рядок ≤ 64 (дзеркалить @MaxLength(64)).
const trackingNumberField = z.preprocess(
  v => (v === '' || v === null || v === undefined ? undefined : v),
  z.string().max(64, 'Номер накладної не більше 64 символів').optional(),
);

// Форма/create: обовʼязкові supplierId/warehouseId; решта опційні.
export const purchaseOrderFormSchema = z.object({
  supplierId: z.string().uuid('Оберіть постачальника'),
  warehouseId: z.string().uuid('Оберіть склад'),
  contractId: optionalUuid(),
  notes: optionalString(),
  documentDate: optionalDateString(),
  currencyId: optionalUuid(),
  paymentDate: optionalDateString(),
  trackingNumber: trackingNumberField,
  lines: z.array(purchaseOrderLineSchema).default([]),
});
export type PurchaseOrderFormValues = z.infer<typeof purchaseOrderFormSchema>;
export type PurchaseOrderFormInput = z.input<typeof purchaseOrderFormSchema>;

export const purchaseOrderCreateSchema = purchaseOrderFormSchema;
export type PurchaseOrderCreateValues = PurchaseOrderFormValues;

// nullable UUID/рядок для update: null → очистити; '' → undefined (не чіпати); UUID/рядок → встановити.
const nullableUuidField = z.preprocess(
  v => (v === '' || v === undefined ? undefined : v),
  z.union([z.string().uuid('Невірний UUID формат'), z.null()]).optional(),
);
const nullableTrackingField = z.preprocess(
  v => (v === '' || v === undefined ? undefined : v),
  z.union([z.string().max(64, 'Номер накладної не більше 64 символів'), z.null()]).optional(),
);

// Update — усі поля опційні; contractId/trackingNumber nullable (null очищає).
export const purchaseOrderUpdateSchema = z.object({
  supplierId: optionalUuid(),
  warehouseId: optionalUuid(),
  contractId: nullableUuidField,
  notes: optionalString(),
  documentDate: optionalDateString(),
  currencyId: optionalUuid(),
  paymentDate: optionalDateString(),
  trackingNumber: nullableTrackingField,
  lines: z.array(purchaseOrderLineSchema).optional(),
});
export type PurchaseOrderUpdateValues = z.infer<typeof purchaseOrderUpdateSchema>;
