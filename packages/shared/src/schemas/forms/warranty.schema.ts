import { z } from 'zod';
import { optionalString } from '../validators';

/**
 * Спільна zod-схема форми гарантії (Warranty) — ЄДИНЕ джерело правди валідації для web і api.
 *
 * `expiresAt` — дата у форматі YYYY-MM-DD з DatePickerInput. Бек вимагає майбутню дату (інакше 400),
 * тож схема перевіряє це ще на формі: порівняння по КОМПОНЕНТАХ дати (не Date-арифметика), щоб
 * уникнути зсуву через часовий пояс браузера; `today` передається викликачем у Kyiv-TZ.
 */
export const warrantyFormSchema = z.object({
  expiresAt: z
    .string()
    .trim()
    .min(1, 'v.warranty.expiresAt.required')
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'v.warranty.expiresAt.format'),
  description: optionalString(),
});

/** Значення форми ПІСЛЯ парсингу (порожні опційні — undefined). */
export type WarrantyFormValues = z.infer<typeof warrantyFormSchema>;

/** Вхідні значення форми (web-стан) — до коерції. */
export type WarrantyFormInput = z.input<typeof warrantyFormSchema>;
