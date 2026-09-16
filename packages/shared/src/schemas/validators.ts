import { z } from 'zod';

export const PHONE_UA_REGEX = /^\+380\d{9}$/;
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const IBAN_UA_REGEX = /^UA\d{27}$/;
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const phoneUaSchema = z
  .string()
  .regex(PHONE_UA_REGEX, 'Невірний формат телефону (+380XXXXXXXXX)');
export const emailSchema = z.string().email('Невірний формат email');
export const ibanUaSchema = z.string().regex(IBAN_UA_REGEX, 'Невірний формат IBAN (UA + 27 цифр)');
/** Field-level UUID validator (regex-based). See also uuidSchema in schemas.ts for Zod .uuid(). */
export const uuidFieldSchema = z.string().regex(UUID_REGEX, 'Невірний UUID формат');
export const positiveNumberSchema = z.number().positive('Значення має бути більше нуля');
export const nonNegativeNumberSchema = z.number().min(0, "Значення не може бути від'ємним");

/**
 * Форма-хелпери для спільних zod-схем (web ↔ api).
 *
 * Web-поля майже завжди рядки (навіть числа/дати): порожній рядок означає «не задано».
 * Ці хелпери дзеркалять беківський `@Transform(emptyToUndefined)` + `@Type(() => Number)`,
 * щоб ОДНА схема валідувала і рядковий payload з форми, і вже-типізований JSON.
 */

/** Порожній рядок / null → undefined (перед .optional()). Дзеркалить emptyToUndefined на беку. */
export const emptyToUndefined = (v: unknown): unknown => (v === '' || v === null ? undefined : v);

/** Опційний рядок: '' → undefined, trim не робимо (робить бек/схема за потреби). */
export const optionalString = () => z.preprocess(emptyToUndefined, z.string().optional());

/** Опційний UUID: '' → undefined, інакше валідний UUID. */
export const optionalUuid = () => z.preprocess(emptyToUndefined, uuidFieldSchema.optional());

/**
 * Опційне невід'ємне число з коерцією з рядка: '' → undefined, '350' → 350.
 * `z.coerce.number()` перетворює рядок; порожнє відсікаємо ДО коерції (інакше '' → 0).
 */
export const optionalNonNegNumber = () =>
  z.preprocess(
    emptyToUndefined,
    z.coerce.number().min(0, "Значення не може бути від'ємним").optional(),
  );
