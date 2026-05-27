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

// Module-level cache so all components share one fetch.
// On fetch failure we cache DEFAULTS for FAILURE_TTL_MS to avoid network spam
// (e.g. when the user's role lacks permission or backend is offline).
let cache: UiFeatures | null = null;
let cacheExpiresAt = 0;
let pending: Promise<UiFeatures> | null = null;
const FAILURE_TTL_MS = 60_000; // 1 minute — short enough to recover after role change

async function loadFeatures(): Promise<UiFeatures> {
  if (cache && Date.now() < cacheExpiresAt) return cache;
  // No token → unauthenticated render; return defaults without making a request.
  // After login the sto:ui-features-change event will trigger a real fetch.
  if (typeof window !== 'undefined' && !sessionStorage.getItem('sto_access_token')) {
    return DEFAULTS;
  }
  if (!pending) {
    pending = apiFetch<Partial<UiFeatures>>('/settings/ui-features')
      .then(features => {
        cache = { ...DEFAULTS, ...(features ?? {}) };
        cacheExpiresAt = Number.MAX_SAFE_INTEGER; // success → permanent until invalidate
        pending = null;
        return cache;
      })
      .catch(() => {
        cache = DEFAULTS;
        cacheExpiresAt = Date.now() + FAILURE_TTL_MS;
        pending = null;
        return DEFAULTS;
      });
  }
  return pending;
}

export function invalidateUiFeaturesCache() {
  cache = null;
  cacheExpiresAt = 0;
  pending = null;
}

export function useUiFeatures(): UiFeatures {
  const [features, setFeatures] = useState<UiFeatures>(cache ?? DEFAULTS);

  useEffect(() => {
    let cancelled = false;
    loadFeatures().then(f => { if (!cancelled) setFeatures(f); });
    return () => { cancelled = true; };
  }, []);

  // Re-sync when settings are updated; reset on logout to avoid cross-tenant leak.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      invalidateUiFeaturesCache();
      loadFeatures().then(f => { if (!cancelled) setFeatures(f); });
    };
    const onLogout = () => {
      invalidateUiFeaturesCache();
      if (!cancelled) setFeatures(DEFAULTS);
    };
    const onLogin = () => {
      invalidateUiFeaturesCache();
      loadFeatures().then(f => { if (!cancelled) setFeatures(f); });
    };
    window.addEventListener('sto:ui-features-change', refresh);
    window.addEventListener('sto:logout', onLogout);
    window.addEventListener('sto:login', onLogin);
    return () => {
      cancelled = true;
      window.removeEventListener('sto:ui-features-change', refresh);
      window.removeEventListener('sto:logout', onLogout);
      window.removeEventListener('sto:login', onLogin);
    };
  }, []);

  return features;
}
