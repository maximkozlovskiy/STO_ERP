'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { applyLocale } from '@/i18n/apply';
import { STORAGE_KEY, resolveInitialLocale } from '@/i18n/config';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, isLocale, type Locale } from '@/i18n/locale';
import type { OrgSettings } from '@/app/(app)/settings/shared';

const TS_KEY = 'sto_locale_ts';
const API_KEY = 'locale';
const CACHE_TTL_MS = 5 * 60 * 1000;
export const LOCALE_CHANGE_EVENT = 'sto:locale-change';

/**
 * Вибір мови інтерфейсу. Дзеркалить useNavConfig: localStorage-кеш (TTL 5хв) + user-override через
 * /user-preferences (key `locale`), offline-tolerant. Резолюція: user-override → org-default
 * (OrgSettings.language) → 'uk'. setLanguage застосовує i18next + <html lang> + broadcast + PUT.
 */
export function useLanguage() {
  const [locale, setLocale] = useState<Locale>(resolveInitialLocale());
  const [loading, setLoading] = useState(true);
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const putAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => putAbortRef.current?.abort();
  }, []);

  // Первинна реконсиляція: user-override wins, інакше org-default, інакше uk.
  useEffect(() => {
    let cancelled = false;
    let skipFetch = false;
    try {
      const ts = Number(localStorage.getItem(TS_KEY) ?? 0);
      if (isLocale(localStorage.getItem(STORAGE_KEY)) && Date.now() - ts < CACHE_TTL_MS) {
        skipFetch = true;
      }
    } catch {
      /* ignore */
    }
    if (skipFetch) {
      setLoading(false);
      return;
    }

    // `void`: кожен await усередині вже має власний try/catch (offline-tolerant резолюція
    // locale), тож цей IIFE-проміс не реджектиться, а його результат осідає у setLocale.
    void (async () => {
      let resolved: Locale | null = null;
      // 1) per-user override
      try {
        const res = await apiFetch<{ key: string; value: { locale?: string } }>(
          `/user-preferences/${API_KEY}`,
        );
        if (isLocale(res.value?.locale)) resolved = res.value.locale;
      } catch {
        /* немає override або offline */
      }
      // 2) org-default
      if (!resolved) {
        try {
          const org = await apiFetch<OrgSettings>('/settings/organisation');
          if (isLocale(org.language)) resolved = org.language;
        } catch {
          /* offline → лишаємо кеш/дефолт */
        }
      }
      if (cancelled) return;
      const next = resolved ?? DEFAULT_LOCALE;
      if (next !== localeRef.current) {
        setLocale(next);
        applyLocale(next);
        try {
          localStorage.setItem(STORAGE_KEY, next);
          localStorage.setItem(TS_KEY, String(Date.now()));
        } catch {
          /* ignore */
        }
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Синхронізація між вкладками/компонентами + reset на logout.
  useEffect(() => {
    const onChange = () => {
      const l = resolveInitialLocale();
      if (l !== localeRef.current) {
        setLocale(l);
        applyLocale(l);
      }
    };
    const onLogout = () => {
      setLocale(DEFAULT_LOCALE);
      applyLocale(DEFAULT_LOCALE);
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, onChange);
    window.addEventListener('sto:logout', onLogout);
    return () => {
      window.removeEventListener(LOCALE_CHANGE_EVENT, onChange);
      window.removeEventListener('sto:logout', onLogout);
    };
  }, []);

  const setLanguage = useCallback((next: Locale) => {
    if (!isLocale(next)) return;
    localeRef.current = next;
    setLocale(next);
    applyLocale(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
      localStorage.setItem(TS_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent(LOCALE_CHANGE_EVENT));
    // Персист per-user (offline-tolerant, abort-dedup).
    putAbortRef.current?.abort();
    const ac = new AbortController();
    putAbortRef.current = ac;
    void apiFetch(`/user-preferences/${API_KEY}`, {
      method: 'PUT',
      body: JSON.stringify({ key: API_KEY, value: { locale: next } }),
      signal: ac.signal,
    }).catch((e: unknown) => {
      // abort — нормальний результат dedup (користувач швидко перемкнув мову двічі), не помилка.
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (ac.signal.aborted) return;
      // Реальний збій PUT: мова застосована локально (i18next + localStorage) і переживе
      // перезавантаження, але НЕ зберіглась у профілі — на іншому пристрої користувач
      // побачить стару мову. Раніше це глушилось повністю, і він вважав вибір збереженим.
      toast.warning('Мову застосовано лише на цьому пристрої — не вдалося зберегти у профілі.');
    });
  }, []);

  return { locale, setLanguage, supported: SUPPORTED_LOCALES, loading };
}
