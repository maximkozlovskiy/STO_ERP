'use client';

import { useState, useEffect } from 'react';
import { apiFetch } from '@/lib/api-client';

export interface UiFeatures {
  toastEnabled: boolean;
  unsavedGuardEnabled: boolean;
  stockIndicatorEnabled: boolean;
  commandPaletteEnabled: boolean;
  keyboardShortcutsEnabled: boolean;
  savedFiltersEnabled: boolean;
  inlineEditEnabled: boolean;
  syncIndicatorEnabled: boolean;
  notificationCenterEnabled: boolean;
  bulkActionsEnabled: boolean;
}

const DEFAULTS: UiFeatures = {
  toastEnabled: true,
  unsavedGuardEnabled: true,
  stockIndicatorEnabled: true,
  commandPaletteEnabled: true,
  keyboardShortcutsEnabled: true,
  savedFiltersEnabled: true,
  inlineEditEnabled: true,
  syncIndicatorEnabled: true,
  notificationCenterEnabled: true,
  bulkActionsEnabled: true,
};

// Module-level cache so all components share one fetch
let cache: UiFeatures | null = null;
let pending: Promise<UiFeatures> | null = null;

async function loadFeatures(): Promise<UiFeatures> {
  if (cache) return cache;
  if (!pending) {
    pending = apiFetch<{ uiFeatures: Partial<UiFeatures> }>('/settings/organisation')
      .then(s => {
        cache = { ...DEFAULTS, ...(s.uiFeatures ?? {}) };
        return cache;
      })
      .catch(() => {
        pending = null;
        return DEFAULTS;
      });
  }
  return pending;
}

export function invalidateUiFeaturesCache() {
  cache = null;
  pending = null;
}

export function useUiFeatures(): UiFeatures {
  const [features, setFeatures] = useState<UiFeatures>(cache ?? DEFAULTS);

  useEffect(() => {
    let cancelled = false;
    loadFeatures().then(f => { if (!cancelled) setFeatures(f); });
    return () => { cancelled = true; };
  }, []);

  // Re-sync when settings are updated
  useEffect(() => {
    const handler = () => {
      invalidateUiFeaturesCache();
      loadFeatures().then(setFeatures);
    };
    window.addEventListener('sto:ui-features-change', handler);
    return () => window.removeEventListener('sto:ui-features-change', handler);
  }, []);

  return features;
}
