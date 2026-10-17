import { z } from 'zod';
import { optionalUuid, moneyString } from '../validators';

/**
 * Списки купівлі (docs/objects/purchase-list.md, BR-PL-*) — ЄДИНЕ джерело правди web ↔ api для тіл
 * запитів `purchase-lists` і `purchase-list-items`.
 *
 * Кількості — у БАЗОВИХ одиницях товару (BR-PL-002). При надсиланні з наряду кількість необов'язкова:
 * сервер бере непокриту потребу рядка (BR-PL-003).
 *
 * Поля «скинути» (supplierId, expectedPrice, warehouseId списку): null → очистити, undefined → не чіпати.
 */

/** Межа кількості позицій/рядків в одному запиті — дзеркалить @ArrayMaxSize на бекенді. */
export const PURCHASE_LIST_BATCH_MAX = 200;

const uuid = (msg: string) => z.string().uuid(msg);
const blankToUndefined = (v: unknown): unknown => (v === '' || v === null ? undefined : v);
const blankToNull = (v: unknown): unknown => (v === '' ? null : v);

const quantityField = () =>
  moneyString().pipe(z.number().min(0.001, 'v.purchaseList.quantity.min'));
const optionalQuantity = () =>
  z.preprocess(
    blankToUndefined,
    moneyString().pipe(z.number().min(0.001, 'v.purchaseList.quantity.min')).optional(),
  );
const optionalPrice = () =>
  z.preprocess(
    blankToUndefined,
    moneyString().pipe(z.number().min(0, 'v.purchaseList.price.nonNeg')).optional(),
  );
const nameField = () =>
  z.preprocess(blankToUndefined, z.string().max(120, 'v.purchaseList.name.max').optional());
const notesField = () =>
  z.preprocess(blankToUndefined, z.string().max(1000, 'v.purchaseList.notes.max').optional());
const nullableUuid = () =>
  z.preprocess(
    blankToNull,
    z.union([z.string().uuid('v.purchaseList.uuid.invalid'), z.null()]).optional(),
  );
const nullablePrice = () =>
  z.preprocess(
    blankToNull,
    z
      .union([moneyString().pipe(z.number().min(0, 'v.purchaseList.price.nonNeg')), z.null()])
      .optional(),
  );
const itemIds = () =>
  z
    .array(uuid('v.purchaseList.uuid.invalid'))
    .min(1, 'v.purchaseList.items.required')
    .max(PURCHASE_LIST_BATCH_MAX, 'v.purchaseList.items.max');

// ── Список ────────────────────────────────────────────────────────────────────

export const purchaseListCreateSchema = z.object({
  name: nameField(),
  warehouseId: optionalUuid(),
  notes: notesField(),
});
export type PurchaseListCreateValues = z.infer<typeof purchaseListCreateSchema>;

export const purchaseListUpdateSchema = z.object({
  name: nameField(),
  warehouseId: nullableUuid(),
  notes: notesField(),
});
export type PurchaseListUpdateValues = z.infer<typeof purchaseListUpdateSchema>;

/** BR-PL-006: позиції списків-джерел переходять у цільовий, джерела закриваються. */
export const purchaseListMergeSchema = z.object({
  targetListId: uuid('v.purchaseList.uuid.invalid'),
  sourceListIds: z
    .array(uuid('v.purchaseList.uuid.invalid'))
    .min(1, 'v.purchaseList.sources.required')
    .max(50, 'v.purchaseList.items.max'),
});
export type PurchaseListMergeValues = z.infer<typeof purchaseListMergeSchema>;

// ── З наряду (BR-PL-003) ──────────────────────────────────────────────────────

export const purchaseListFromWorkOrderSchema = z.object({
  workOrderId: uuid('v.purchaseList.uuid.invalid'),
  /** Наявний OPEN-список. Без нього — новий список (newList). */
  listId: optionalUuid(),
  newList: z.object({ name: nameField(), notes: notesField() }).optional(),
  parts: z
    .array(
      z.object({
        workOrderPartId: uuid('v.purchaseList.uuid.invalid'),
        /** Базові одиниці; не вказано — непокрита потреба рядка. */
        quantity: optionalQuantity(),
      }),
    )
    .min(1, 'v.purchaseList.parts.required')
    .max(PURCHASE_LIST_BATCH_MAX, 'v.purchaseList.items.max'),
});
export type PurchaseListFromWorkOrderValues = z.infer<typeof purchaseListFromWorkOrderSchema>;

// ── Позиції ───────────────────────────────────────────────────────────────────

/** BR-PL-004: ручна позиція. */
export const purchaseListManualItemSchema = z.object({
  goodId: uuid('v.purchaseList.good.required'),
  warehouseId: uuid('v.purchaseList.warehouse.required'),
  quantity: quantityField(),
  supplierId: optionalUuid(),
  expectedPrice: optionalPrice(),
  notes: notesField(),
});
export type PurchaseListManualItemValues = z.infer<typeof purchaseListManualItemSchema>;

/** BR-PL-005: лише OPEN-позиція. */
export const purchaseListItemUpdateSchema = z.object({
  quantity: optionalQuantity(),
  supplierId: nullableUuid(),
  expectedPrice: nullablePrice(),
  notes: notesField(),
});
export type PurchaseListItemUpdateValues = z.infer<typeof purchaseListItemUpdateSchema>;

/** BR-PL-007: частина OPEN-позиції стає новою позицією з тими самими зв'язками. */
export const purchaseListItemSplitSchema = z.object({ quantity: quantityField() });
export type PurchaseListItemSplitValues = z.infer<typeof purchaseListItemSplitSchema>;

/** BR-PL-007: перенести OPEN-позиції в наявний OPEN-список або в новий. */
export const purchaseListItemsMoveSchema = z.object({
  itemIds: itemIds(),
  targetListId: optionalUuid(),
  newListName: nameField(),
});
export type PurchaseListItemsMoveValues = z.infer<typeof purchaseListItemsMoveSchema>;

export const purchaseListItemsBulkUpdateSchema = z.object({
  itemIds: itemIds(),
  supplierId: nullableUuid(),
  expectedPrice: nullablePrice(),
});
export type PurchaseListItemsBulkUpdateValues = z.infer<typeof purchaseListItemsBulkUpdateSchema>;

/** bulk-cancel і create-orders (BR-PL-008). */
export const purchaseListItemIdsSchema = z.object({ itemIds: itemIds() });
export type PurchaseListItemIdsValues = z.infer<typeof purchaseListItemIdsSchema>;
