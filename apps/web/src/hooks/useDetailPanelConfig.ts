'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { PanelFieldConfig } from '@/lib/panel-schema';

const STORAGE_PREFIX = 'sto_panel_cfg_';

export function useDetailPanelConfig(pageKey: string) {
  const storageKey = `${STORAGE_PREFIX}${pageKey}`;
  const apiKey = `detail_panel_${pageKey}`;

  const [config, setConfig] = useState<PanelFieldConfig>({ hiddenFields: [], fieldOrder: [] });
  const [loading, setLoading] = useState(true);

  // WEB-M13: ref завжди тримає ОСТАННІЙ config. Мутатори (toggleField/reorderFields) читають
  // `next` із цього ref, а не із captured-у-замиканні `config` — інакше два швидкі кліки в одному
  // tick (до re-render) читали б стейл-config → другий губив би зміну першого (lost-update
  // value-based setState). Ref оновлюється синхронно у мутаторі, тож послідовні виклики чейняться.
  const configRef = useRef(config);
  configRef.current = config;

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const putAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    const TS_KEY = `${storageKey}_ts`;
    const CACHE_TTL_MS = 5 * 60 * 1000;

    let skipFetch = false;
    try {
      const cached = localStorage.getItem(storageKey);
      const ts = Number(localStorage.getItem(TS_KEY) ?? 0);
      if (cached) {
        const parsed = JSON.parse(cached) as Partial<PanelFieldConfig>;
        setConfig({ hiddenFields: parsed.hiddenFields ?? [], fieldOrder: parsed.fieldOrder ?? [] });
        if (Date.now() - ts < CACHE_TTL_MS) skipFetch = true;
      }
    } catch {
      /* ignore */
    }

    if (skipFetch) {
      setLoading(false);
      return;
    }

    apiFetch<{ key: string; value: PanelFieldConfig }>(`/user-preferences/${apiKey}`)
      .then(res => {
        if (cancelled) return;
        const v = res.value;
        const cfg: PanelFieldConfig = {
          hiddenFields: Array.isArray(v?.hiddenFields) ? v.hiddenFields : [],
          fieldOrder: Array.isArray(v?.fieldOrder) ? v.fieldOrder : [],
        };
        setConfig(cfg);
        try {
          localStorage.setItem(storageKey, JSON.stringify(cfg));
          localStorage.setItem(TS_KEY, String(Date.now()));
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        /* offline: use localStorage */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiKey, storageKey]);

  const savePref = useCallback(
    (next: PanelFieldConfig) => {
      putAbortRef.current?.abort();
      const ac = new AbortController();
      putAbortRef.current = ac;
      try {
        localStorage.setItem(`${STORAGE_PREFIX}${pageKey}_ts`, String(Date.now()));
      } catch {
        /* ignore */
      }
      apiFetch(`/user-preferences/${apiKey}`, {
        method: 'PUT',
        body: JSON.stringify({ key: apiKey, value: next }),
        signal: ac.signal,
      }).catch(() => {
        /* AbortError or network: silent */
      });
    },
    [apiKey, pageKey],
  );

  const isFieldHidden = useCallback(
    (fieldKey: string) => config.hiddenFields.includes(fieldKey),
    [config],
  );

  // WEB-M13: side-effect (localStorage + savePref PUT) винесено ПОЗА state-updater. Updater має
  // бути чистим — під React StrictMode dev він викликається двічі, що дублювало PUT/запис.
  const persist = useCallback(
    (next: PanelFieldConfig) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      savePref(next);
    },
    [storageKey, savePref],
  );

  const toggleField = useCallback(
    (fieldKey: string) => {
      // next обчислюється з configRef.current (найсвіжіший стан, не stale-замикання) → два кліки
      // в одному tick чейняться коректно; side-effect persist() один раз (поза state-updater).
      const cur = configRef.current;
      const next: PanelFieldConfig = {
        ...cur,
        hiddenFields: cur.hiddenFields.includes(fieldKey)
          ? cur.hiddenFields.filter(k => k !== fieldKey)
          : [...cur.hiddenFields, fieldKey],
      };
      configRef.current = next; // синхронно — наступний виклик у тому ж tick бачить цю зміну
      setConfig(next);
      persist(next);
    },
    [persist],
  );

  const reorderFields = useCallback(
    (newOrder: string[]) => {
      const next: PanelFieldConfig = { ...configRef.current, fieldOrder: newOrder };
      configRef.current = next;
      setConfig(next);
      persist(next);
    },
    [persist],
  );

  const reset = useCallback(() => {
    const empty: PanelFieldConfig = { hiddenFields: [], fieldOrder: [] };
    configRef.current = empty; // тримаємо ref у синхроні (мутатори читають звідси)
    if (mountedRef.current) setConfig(empty);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
    savePref(empty);
  }, [storageKey, savePref]);

  useEffect(
    () => () => {
      putAbortRef.current?.abort();
      putAbortRef.current = null;
    },
    [],
  );

  return { isFieldHidden, toggleField, reorderFields, reset, loading, config };
}
