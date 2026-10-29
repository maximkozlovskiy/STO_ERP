'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { applyTheme } from '@/lib/theme';

export const brandingQueryKey = ['settings', 'branding'] as const;

/** Кеш назви організації: шапка меню показує її з першого кадру, а не «OneService» → назва. */
const ORG_NAME_STORAGE_KEY = 'sto_org_name';

interface Branding {
  brandTheme: string;
  orgName: string | null;
}

function cachedOrgName(): string | null {
  try {
    return localStorage.getItem(ORG_NAME_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Палітра й назва організації для оболонки застосунку. До 2026-10-29 палітру застосовували лише
 * сторінки «Налаштування → Оформлення» і «НДІ», тож після жорсткого оновлення (Ctrl+Shift+R)
 * інтерфейс повертався до синього. Скрипт у <head> ставить кешовану палітру до першого кадру; цей
 * хук звіряє її з сервером (`GET /settings/branding` — усі ролі) і повертає назву організації.
 */
export function useBrandTheme(enabled: boolean): { orgName: string | null } {
  const { data } = useQuery({
    queryKey: brandingQueryKey,
    queryFn: () => apiFetch<Branding>('/settings/branding'),
    enabled,
    staleTime: 30 * 60 * 1000,
  });

  useEffect(() => {
    if (data?.brandTheme) applyTheme(data.brandTheme);
  }, [data?.brandTheme]);

  useEffect(() => {
    if (!data) return;
    try {
      if (data.orgName) localStorage.setItem(ORG_NAME_STORAGE_KEY, data.orgName);
      else localStorage.removeItem(ORG_NAME_STORAGE_KEY);
    } catch {
      /* приватний режим — назва прийде з API при наступному завантаженні */
    }
  }, [data]);

  return { orgName: data ? data.orgName : enabled ? cachedOrgName() : null };
}
