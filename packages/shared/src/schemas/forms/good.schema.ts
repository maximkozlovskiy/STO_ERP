import { z } from 'zod';
import { optionalString, optionalUuid, optionalNonNegNumber } from '../validators';

/**
 * Спільна zod-схема форми товару (Good) — ЄДИНЕ джерело правди валідації для web і api.
 *
 * Web-форма (react-hook-form + zodResolver) і бек (ZodValidationPipe) валідують ОДНІЄЮ схемою,
 * тож повідомлення й правила збігаються — усуває клас багів «фронт ок, бек 400».
 * Поля-рядки з форми коерсяться (порожній рядок → undefined; число з рядка → number).
 */

export const GOOD_TYPE_VALUES = ['SPARE_PART', 'CONSUMABLE', 'MATERIAL', 'TOOL'] as const;
export type GoodTypeValue = (typeof GOOD_TYPE_VALUES)[number];

export const goodFormSchema = z.object({
  name: z.string().trim().min(1, 'Вкажіть назву товару').max(300, 'Назва занадто довга'),
  sku: optionalString(),
  unit: optionalString(),
  unitId: optionalUuid(),
  brandId: optionalUuid(),
  purchasePrice: optionalNonNegNumber(),
  salePrice: optionalNonNegNumber(),
  category: optionalString(),
  goodCategoryId: optionalUuid(),
  barcode: optionalString(),
  notes: optionalString(),
  goodType: z.preprocess(
    v => (v === '' || v === null ? undefined : v),
    z.enum(GOOD_TYPE_VALUES).optional(),
  ),
  preferredSupplierId: optionalUuid(),
});

/**
 * Схема часткового оновлення (PATCH): усі поля опційні, включно з name.
 * Для update-ендпоінта, який приймає лише змінені поля.
 */
export const goodUpdateSchema = goodFormSchema.partial();

/** Значення форми ПІСЛЯ парсингу (числа — number, порожні опційні — undefined). */
export type GoodFormValues = z.infer<typeof goodFormSchema>;
export type GoodUpdateValues = z.infer<typeof goodUpdateSchema>;

/** Вхідні значення форми (web-стан) — до коерції; усе рядкове/опційне. */
export type GoodFormInput = z.input<typeof goodFormSchema>;
