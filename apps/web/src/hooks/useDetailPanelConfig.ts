'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/api-client';

interface PanelConfig {
  hiddenFields: string[]; // fieldKey values that are hidden
}

const STORAGE_PREFIX = 'sto_panel_cfg_'; // fallback localStorage

export function useDetailPanelConfig(pageKey: string) {
  const storageKey = `${STORAGE_PREFIX}${pageKey}`;
  const apiKey = `detail_panel_${pageKey}`;

  const [config, setConfig] = useState<PanelConfig>({ hiddenFields: [] });
  const [loading, setLoading] = useState(true);

  // Track mounted state — fire-and-forget PUTs з toggleField/reset не мають setState
  // на unmounted компонент (race коли користувач перейшов на іншу сторінку).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // AbortController для PUT-черги: rapid toggle → cancel попередній in-flight PUT,
  // інакше last-arrived-wins може зберегти стале значення на сервері.
  const putAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Optimistic: показати з localStorage поки завантажується з API
    try {
      const cached = localStorage.getItem(storageKey);
      if (cached && !cancelled) setConfig(JSON.parse(cached) as PanelConfig);
    } catch { /* ignore */ }

    apiFetch<{ key: string; value: PanelConfig }>(`/user-preferences/${apiKey}`)
      .then(res => {
        if (cancelled) return;
        const cfg =
          res.value && typeof res.value === 'object' && 'hiddenFields' in res.value
            ? (res.value as PanelConfig)
            : { hiddenFields: [] };
        setConfig(cfg);
        try { localStorage.setItem(storageKey, JSON.stringify(cfg)); } catch { /* ignore quota */ }
      })
      .catch(() => { /* offline: use localStorage */ })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [apiKey, storageKey]);

  // Окремий стабільний savePref: cancel previous PUT + AbortController на новий.
  // Не setState на unmount; не використовуємо apiFetch без catch (silent fail OK для UX —
  // зміна вже у localStorage).
  const savePref = useCallback((next: PanelConfig) => {
    putAbortRef.current?.abort();
    const ac = new AbortController();
    putAbortRef.current = ac;
    apiFetch(`/user-preferences/${apiKey}`, {
      method: 'PUT',
      body: JSON.stringify({ key: apiKey, value: next }),
      signal: ac.signal,
    }).catch(() => { /* AbortError or network: silent — localStorage already updated */ });
  }, [apiKey]);

  const isFieldHidden = useCallback(
    (fieldKey: string) => config.hiddenFields.includes(fieldKey),
    [config],
  );

  const toggleField = useCallback(
    (fieldKey: string) => {
      setConfig(prev => {
        const next: PanelConfig = prev.hiddenFields.includes(fieldKey)
          ? { hiddenFields: prev.hiddenFields.filter(k => k !== fieldKey) }
          : { hiddenFields: [...prev.hiddenFields, fieldKey] };
        try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* ignore quota */ }
        savePref(next);
        return next;
      });
    },
    [storageKey, savePref],
  );

  const reset = useCallback(() => {
    const empty: PanelConfig = { hiddenFields: [] };
    if (mountedRef.current) setConfig(empty);
    try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
    savePref(empty);
  }, [storageKey, savePref]);

  // Cancel pending PUT on unmount
  useEffect(() => () => {
    putAbortRef.current?.abort();
    putAbortRef.current = null;
  }, []);

  return { isFieldHidden, toggleField, reset, loading, config };
}
