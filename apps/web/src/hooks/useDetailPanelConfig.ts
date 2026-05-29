'use client';

import { useState, useEffect, useCallback } from 'react';
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

  useEffect(() => {
    // Optimistic: показати з localStorage поки завантажується з API
    try {
      const cached = localStorage.getItem(storageKey);
      if (cached) setConfig(JSON.parse(cached) as PanelConfig);
    } catch { /* ignore */ }

    apiFetch<{ key: string; value: PanelConfig }>(`/user-preferences/${apiKey}`)
      .then(res => {
        const cfg =
          res.value && typeof res.value === 'object' && 'hiddenFields' in res.value
            ? (res.value as PanelConfig)
            : { hiddenFields: [] };
        setConfig(cfg);
        localStorage.setItem(storageKey, JSON.stringify(cfg));
      })
      .catch(() => { /* offline: use localStorage */ })
      .finally(() => setLoading(false));
  }, [apiKey, storageKey]);

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
        localStorage.setItem(storageKey, JSON.stringify(next));
        // Fire-and-forget save
        apiFetch(`/user-preferences/${apiKey}`, {
          method: 'PUT',
          body: JSON.stringify({ key: apiKey, value: next }),
        }).catch(() => {});
        return next;
      });
    },
    [apiKey, storageKey],
  );

  const reset = useCallback(() => {
    const empty: PanelConfig = { hiddenFields: [] };
    setConfig(empty);
    localStorage.removeItem(storageKey);
    apiFetch(`/user-preferences/${apiKey}`, {
      method: 'PUT',
      body: JSON.stringify({ key: apiKey, value: empty }),
    }).catch(() => {});
  }, [apiKey, storageKey]);

  return { isFieldHidden, toggleField, reset, loading, config };
}
