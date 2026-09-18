'use client';

import { useEffect, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n, { resolveInitialLocale } from '@/i18n/config';
import { applyLocale } from '@/i18n/apply';

/**
 * Клієнтський i18n-провайдер (дзеркалить ColorModeProvider). config.ts вже ініціалізував i18next
 * синхронно з localStorage-локаллю (no-flash). Тут лише вирівнюємо format.ts-реєстр + <html lang>
 * з тією ж локаллю на маунті. Async-реконсиляція (user-override/org-default) — у useLanguage.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    applyLocale(resolveInitialLocale());
  }, []);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
