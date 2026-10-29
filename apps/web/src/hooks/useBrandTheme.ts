'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { applyTheme } from '@/lib/theme';

export const brandingQueryKey = ['settings', 'branding'] as const;

/**
 * Палітра організації для оболонки застосунку. До 2026-10-29 її застосовували лише сторінки
 * «Налаштування → Оформлення» і «НДІ», тож після жорсткого оновлення (Ctrl+Shift+R) інтерфейс
 * повертався до синього, хоча в налаштуваннях обрано інший колір. Скрипт у <head> ставить кешовану
 * палітру до першого кадру; цей хук звіряє її з сервером (`GET /settings/branding` — усі ролі).
 */
export function useBrandTheme(enabled: boolean) {
  const { data } = useQuery({
    queryKey: brandingQueryKey,
    queryFn: () => apiFetch<{ brandTheme: string }>('/settings/branding'),
    enabled,
    staleTime: 30 * 60 * 1000,
  });

  useEffect(() => {
    if (data?.brandTheme) applyTheme(data.brandTheme);
  }, [data?.brandTheme]);
}
