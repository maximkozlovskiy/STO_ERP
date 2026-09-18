// i18next init (client-side, offline). Каталоги — статичні JSON, inline-ються бандлером →
// 0 network-запитів. Під output:'export' (SPA) — pure client, без server/router-зв'язки.
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { resources } from './resources';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, isLocale, type Locale } from './locale';

const STORAGE_KEY = 'sto_locale';

/**
 * Синхронне читання локалі при першому рендері (localStorage) → перший paint одразу
 * правильною мовою, без flash uk→en. SSR/недоступний storage → DEFAULT_LOCALE.
 * Експортується також для inline head-script узгодження та useLanguage.
 */
export function resolveInitialLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (isLocale(cached)) return cached;
  } catch {
    /* private mode / disabled storage */
  }
  return DEFAULT_LOCALE;
}

// Guard проти подвійного init (HMR / повторний import).
if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources,
    lng: resolveInitialLocale(),
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LOCALES as unknown as string[],
    defaultNS: 'common',
    ns: [
      'common',
      'nav',
      'settings',
      'statuses',
      'format',
      'employees',
      'invoices',
      'purchaseOrders',
      'payments',
      'supplierPayments',
      'stockDocuments',
      'counterparties',
    ],
    interpolation: { escapeValue: false }, // React вже екранує
    returnNull: false,
    react: { useSuspense: false }, // каталоги вже в бандлі — Suspense не потрібен
  });
}

export { STORAGE_KEY };
export default i18n;
