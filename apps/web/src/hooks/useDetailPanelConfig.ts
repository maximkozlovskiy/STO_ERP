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
      // next обчислюється з поточного config (не в updater) → side-effect persist() один раз.
      const next: PanelFieldConfig = {
        ...config,
        hiddenFields: config.hiddenFields.includes(fieldKey)
          ? config.hiddenFields.filter(k => k !== fieldKey)
          : [...config.hiddenFields, fieldKey],
      };
      setConfig(next);
      persist(next);
    },
    [config, persist],
  );

  const reorderFields = useCallback(
    (newOrder: string[]) => {
      const next: PanelFieldConfig = { ...config, fieldOrder: newOrder };
      setConfig(next);
      persist(next);
    },
    [config, persist],
  );

  const reset = useCallback(() => {
    const empty: PanelFieldConfig = { hiddenFields: [], fieldOrder: [] };
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
