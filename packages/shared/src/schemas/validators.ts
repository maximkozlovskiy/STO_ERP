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
