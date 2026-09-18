// Спільний i18n-каталог валідаційних повідомлень (web + api, offline — статичний TS у бандлі).
//
// Механізм: zod-повідомлення у schemas стали KEY-ами (напр. 'v.phone'). issue.message = key.
// Кожна сторона резолвить key→локаль на етапі форматування:
//   - api: ZodValidationPipe.formatIssue (locale з ALS getLocale())
//   - web: i18nZodResolver / validateContactFields (locale з getCurrentLocale())
// Та сама schema-об'єкт біжить на обох боках — тому повідомлення НЕ можуть бути локалізовані
// у місці визначення; keys + пізній переклад це вирішують.

import { uk } from './messages.uk';
import { en } from './messages.en';

export { uk, en };
export * from './keys';

export type ValidationLocale = 'uk' | 'en';

const catalogs: Record<ValidationLocale, Record<string, string>> = { uk, en };

/**
 * Резолвить validation-key у локалізований рядок. Fallback-ланцюг: locale → uk → сам key
 * (raw key ніколи не «протікає» у UI поки він є хоча б у uk; повна відсутність → key, ловиться тестом).
 * `params` — інтерполяція {{name}} (напр. v.fieldSuffix {{path}}); більшість повідомлень статичні.
 */
export function translateValidation(
  key: string,
  locale: ValidationLocale = 'uk',
  params?: Record<string, string | number>,
): string {
  const table = catalogs[locale] ?? catalogs.uk;
  let msg = table[key] ?? catalogs.uk[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
    }
  }
  return msg;
}
