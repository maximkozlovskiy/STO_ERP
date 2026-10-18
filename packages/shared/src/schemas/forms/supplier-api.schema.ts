import { z } from 'zod';

/**
 * Постачальники API (docs/objects/supplier-connection.md BR-SCON-*, supplier-offer.md BR-SOFR-*) —
 * ЄДИНЕ джерело правди web ↔ api для тіл запитів `supplier-connections` і `supplier-offers`.
 *
 * Креди — лише на запис (BR-SCON-002): порожнє значення поля не стирає збережене. Склад полів кредів і
 * опцій задає реєстр адаптерів (`GET /supplier-providers`), тут — лише форма «рядок → рядок» / JSON.
 */

export const SUPPLIER_PROVIDERS = [
  'TEHNOMIR',
  'BM_PARTS',
  'UTR',
  'AD_UKRAINE',
  'AVD_TRADE',
] as const;
export type SupplierProviderCode = (typeof SUPPLIER_PROVIDERS)[number];

export const SUPPLIER_STRATEGIES = ['FAST', 'CHEAP', 'OPTIMAL'] as const;
export type SupplierStrategyCode = (typeof SUPPLIER_STRATEGIES)[number];

export const SUPPLIER_ORDER_SEND_MODES = ['MANUAL', 'ON_ORDERED'] as const;
export const SUPPLIER_ANALOG_POLICIES = [
  'CREATE_AND_REPLACE',
  'SHOW_ONLY',
  'CATALOG_ONLY',
] as const;

/** Межа позицій в одному пошуку пропозицій — дзеркалить @ArrayMaxSize на бекенді. */
export const SUPPLIER_OFFER_BATCH_MAX = 100;

const blankToUndefined = (v: unknown): unknown => (v === '' || v === null ? undefined : v);
const blankToNull = (v: unknown): unknown => (v === '' ? null : v);

const credentialsField = () =>
  z.record(z.string(), z.string().max(2000, 'v.supplierConnection.credential.max')).optional();
const optionsField = () => z.record(z.string(), z.unknown()).optional();
const nameField = () =>
  z.preprocess(blankToUndefined, z.string().max(120, 'v.supplierConnection.name.max').optional());
const priorityField = () =>
  z
    .number()
    .int('v.supplierConnection.priority.range')
    .min(0, 'v.supplierConnection.priority.range')
    .max(1000, 'v.supplierConnection.priority.range');
const deliveryDaysField = () =>
  z
    .number()
    .int('v.supplierConnection.deliveryDays.range')
    .min(0, 'v.supplierConnection.deliveryDays.range')
    .max(365, 'v.supplierConnection.deliveryDays.range');
const apiUrlField = () => z.string().url('v.supplierConnection.apiUrl.invalid').max(500);

// ── Підключення (BR-SCON-001…003) ─────────────────────────────────────────────

export const supplierConnectionCreateSchema = z.object({
  counterpartyId: z.string().uuid('v.supplierConnection.counterparty.required'),
  provider: z.enum(SUPPLIER_PROVIDERS, { message: 'v.supplierConnection.provider.required' }),
  name: nameField(),
  enabled: z.boolean().optional(),
  apiUrl: z.preprocess(blankToUndefined, apiUrlField().optional()),
  testMode: z.boolean().optional(),
  priority: priorityField().optional(),
  defaultDeliveryDays: z.preprocess(blankToUndefined, deliveryDaysField().optional()),
  credentials: credentialsField(),
  options: optionsField(),
});
export type SupplierConnectionCreateValues = z.infer<typeof supplierConnectionCreateSchema>;

/** null у apiUrl / defaultDeliveryDays — очистити; undefined — не чіпати. */
export const supplierConnectionUpdateSchema = z.object({
  counterpartyId: z.string().uuid('v.supplierConnection.counterparty.required').optional(),
  name: nameField(),
  enabled: z.boolean().optional(),
  apiUrl: z.preprocess(blankToNull, z.union([apiUrlField(), z.null()]).optional()),
  testMode: z.boolean().optional(),
  priority: priorityField().optional(),
  defaultDeliveryDays: z.preprocess(
    blankToNull,
    z.union([deliveryDaysField(), z.null()]).optional(),
  ),
  credentials: credentialsField(),
  options: optionsField(),
});
export type SupplierConnectionUpdateValues = z.infer<typeof supplierConnectionUpdateSchema>;

// ── Пропозиції й автопідбір (BR-SOFR-002, 006, 009) ───────────────────────────

export const supplierOfferSearchSchema = z.object({
  itemIds: z
    .array(z.string().uuid('v.supplierOffer.uuid.invalid'))
    .min(1, 'v.supplierOffer.items.required')
    .max(SUPPLIER_OFFER_BATCH_MAX, 'v.supplierOffer.items.max'),
  includeAnalogs: z.boolean().optional(),
  /** true — ігнорувати свіжий кеш і запитати постачальників заново. */
  refresh: z.boolean().optional(),
});
export type SupplierOfferSearchValues = z.infer<typeof supplierOfferSearchSchema>;

export const supplierOfferChooseSchema = z.object({
  offerId: z.string().uuid('v.supplierOffer.uuid.invalid'),
});
export type SupplierOfferChooseValues = z.infer<typeof supplierOfferChooseSchema>;

export const supplierOfferAllocateSchema = z.object({
  batchId: z.string().uuid('v.supplierOffer.uuid.invalid'),
  strategy: z.enum(SUPPLIER_STRATEGIES, { message: 'v.supplierOffer.strategy.invalid' }),
  dryRun: z.boolean().optional(),
});
export type SupplierOfferAllocateValues = z.infer<typeof supplierOfferAllocateSchema>;

/** Скасування / видалення замовлення, вже відправленого в API (BR-SCON-014, BR-PO-012). */
export const supplierApiForceSchema = z.object({ force: z.boolean().optional() });
export type SupplierApiForceValues = z.infer<typeof supplierApiForceSchema>;
