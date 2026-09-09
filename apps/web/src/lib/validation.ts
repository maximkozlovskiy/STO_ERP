/**
 * T11: клієнтська валідація форм на основі СПІЛЬНИХ Zod-схем (@sto/shared) — єдине джерело правди
 * з бекендом. Дає миттєвий фідбек користувачу (важливо офлайн, де backend round-trip недоступний) і
 * узгоджені повідомлення. Порожні/необов'язкові поля пропускаються (валідуємо лише заповнені).
 *
 * Використання: перед submit викликати validateFields({...}) → повертає перше повідомлення про
 * помилку (українською) або null, якщо все валідне.
 */
import { phoneUaSchema, emailSchema, ibanUaSchema } from '@sto/shared';

type OptionalStr = string | null | undefined;

/** Перевіряє одне значення схемою, лише якщо воно непорожнє. Повертає повідомлення або null. */
function checkOptional(
  schema: {
    safeParse(v: unknown): { success: boolean; error?: { issues: { message: string }[] } };
  },
  value: OptionalStr,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null; // порожнє необов'язкове поле — валідне
  const res = schema.safeParse(trimmed);
  return res.success ? null : (res.error?.issues[0]?.message ?? 'Невірне значення');
}

export interface ContactFields {
  /** Очікує НОРМАЛІЗОВАНИЙ `+380XXXXXXXXX`. УВАГА: PhoneInput зберігає масковане значення
   *  `+38 (0XX) XXX-XX-XX` — для таких полів phone НЕ передавати (маска вже гарантує формат). */
  phone?: OptionalStr;
  email?: OptionalStr;
  iban?: OptionalStr;
}

/**
 * Валідує контактні поля (email/IBAN + опційно нормалізований телефон). Повертає перше повідомлення
 * про помилку або null. Формати дзеркалять backend (email, IBAN UA+27 цифр, PHONE_UA +380XXXXXXXXX).
 */
export function validateContactFields(f: ContactFields): string | null {
  return (
    checkOptional(phoneUaSchema, f.phone) ??
    checkOptional(emailSchema, f.email) ??
    checkOptional(ibanUaSchema, f.iban)
  );
}
