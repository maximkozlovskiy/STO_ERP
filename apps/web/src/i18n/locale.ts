// Реєстр поточної локалі + мапа на Intl-локаль. Використовується format.ts (locale-aware
// форматери) та I18nProvider. Timezone ЗАВЖДИ Europe/Kyiv — мова НЕ впливає на TZ.

export type Locale = 'uk' | 'en';

export const SUPPORTED_LOCALES: readonly Locale[] = ['uk', 'en'] as const;
export const DEFAULT_LOCALE: Locale = 'uk';

/** Мова → BCP-47 локаль для Intl (числа/дати). uk → uk-UA (1 234,50), en → en-US (1,234.50). */
export const INTL_LOCALE: Record<Locale, string> = {
  uk: 'uk-UA',
  en: 'en-US',
};

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

// Module-level реєстр. format.ts читає getCurrentLocale() у своїх фабриках форматерів.
let current: Locale = DEFAULT_LOCALE;

export function getCurrentLocale(): Locale {
  return current;
}

export function setCurrentLocale(locale: Locale): void {
  current = locale;
}

/** Intl-локаль для поточної мови (для format.ts). */
export function getCurrentIntlLocale(): string {
  return INTL_LOCALE[current];
}
