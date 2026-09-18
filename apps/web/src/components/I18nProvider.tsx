'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n, { resolveInitialLocale } from '@/i18n/config';
import { applyLocale } from '@/i18n/apply';

/**
 * Клієнтський i18n-провайдер (дзеркалить ColorModeProvider). config.ts вже ініціалізував i18next
 * синхронно з localStorage-локаллю (no-flash). Тут вирівнюємо format.ts-реєстр + <html lang>
 * з тією ж локаллю на маунті. Async-реконсиляція (user-override/org-default) — у useLanguage.
 *
 * Live-реактивність: enum-обгортки (woStatusLabel…) і format.ts читають локаль ІМПЕРАТИВНО
 * (без useTranslation), тож самі по собі НЕ ре-рендеряться на зміну мови. Тут підписуємось на
 * i18next `languageChanged` і бампаємо key → цілий піддерево ре-рендериться раз на перемикання
 * → мітки/формати фліпають LIVE на будь-якій відкритій сторінці (без ре-маунту через навігацію).
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    applyLocale(resolveInitialLocale());
    const onChanged = () => setTick(t => t + 1);
    i18n.on('languageChanged', onChanged);
    return () => {
      i18n.off('languageChanged', onChanged);
    };
  }, []);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
