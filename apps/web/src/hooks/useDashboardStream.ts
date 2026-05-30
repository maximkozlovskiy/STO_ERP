'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { TOKEN_KEY } from '@/lib/auth';

export interface DashboardSummary {
  activeWo: number;
  todayRevenue: number;
  pendingInvoices: number;
  lowStockCount: number;
  timestamp: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

// Silent token refresh — mirrors tryRefresh() in api-client.ts
async function tryRefreshToken(): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { accessToken?: string };
    if (data.accessToken) {
      sessionStorage.setItem(TOKEN_KEY, data.accessToken);
      return data.accessToken;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Hook для SSE стріму дашборду з automatic reconnect і silent token refresh.
 * При 401 (прострочений токен) виконує refresh і перепідключається.
 */
export function useDashboardStream() {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // Track consecutive 401s to avoid infinite refresh loop
  const refreshAttemptsRef = useRef(0);
  const MAX_REFRESH_ATTEMPTS = 3;

  const connectSSE = useCallback(async (forceRefresh = false) => {
    if (!mountedRef.current) return;
    if (typeof window === 'undefined') return;

    let token = sessionStorage.getItem(TOKEN_KEY);

    // If forced refresh or no token — try refresh first
    if (forceRefresh || !token) {
      if (refreshAttemptsRef.current >= MAX_REFRESH_ATTEMPTS) {
        setError('Сесія завершена. Оновіть сторінку.');
        return;
      }
      refreshAttemptsRef.current += 1;
      token = await tryRefreshToken();
    }

    if (!token) {
      setError('Токен не знайдено');
      return;
    }

    // Close previous connection before opening new one
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    try {
      const url = `${API_URL}/api/dashboard/stream?token=${encodeURIComponent(token)}`;
      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        if (mountedRef.current) {
          setIsLive(true);
          setError(null);
          refreshAttemptsRef.current = 0; // reset on successful connect
        }
      };

      es.onmessage = event => {
        if (!mountedRef.current) return;
        try {
          const parsed = JSON.parse(event.data) as DashboardSummary;
          setData(parsed);
        } catch {
          // Silently ignore malformed SSE payloads — heartbeat / partial frames
        }
      };

      es.onerror = () => {
        if (!mountedRef.current) return;
        setIsLive(false);
        es.close();
        esRef.current = null;

        // Check if token expired (heuristic: parse exp from JWT)
        const isExpired = isTokenExpired(token!);

        if (isExpired) {
          // Immediate refresh attempt — no delay needed
          setError('Оновлення сесії...');
          connectSSE(true);
        } else {
          // Network error — reconnect after 5s
          setError('Відключено від сервера');
          retryTimeoutRef.current = setTimeout(() => {
            if (mountedRef.current) connectSSE(false);
          }, 5_000);
        }
      };
    } catch (err) {
      if (mountedRef.current) {
        setError(`Помилка підключення: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connectSSE(false);

    return () => {
      mountedRef.current = false;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };
  }, [connectSSE]);

  return { data, isLive, error };
}

/** Returns true if JWT exp claim is within 30s of expiry (or already expired). */
function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(atob(parts[1])) as { exp?: number };
    if (!payload.exp) return false;
    return payload.exp * 1000 < Date.now() + 30_000;
  } catch {
    return false;
  }
}
