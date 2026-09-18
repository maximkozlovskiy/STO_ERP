// Єдина точка застосування локалі до УСІХ підсистем: i18next + format.ts-реєстр + <html lang>.
// Викликається useLanguage.setLanguage та I18nProvider-реконсиляцією.
import i18n from './config';
import { setCurrentLocale, type Locale } from './locale';

export function applyLocale(locale: Locale): void {
  setCurrentLocale(locale); // format.ts форматери
  if (i18n.language !== locale) void i18n.changeLanguage(locale);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
}
