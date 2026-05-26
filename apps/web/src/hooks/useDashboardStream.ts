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

// Канонічна env-змінна — узгоджена з api-client.ts / auth/context.tsx.
// `NEXT_PUBLIC_API_BASE` не існує в проекті — використання призводило до
// localhost у проді і ламаного SSE для real-time дашборду.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

/**
 * Hook для SSE стріму дашборду з automatic reconnect.
 * Якщо EventSource недоступна, fallback на polling (не реалізовано в цій версії).
 */
export function useDashboardStream() {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connectSSE = useCallback(() => {
    if (!mountedRef.current) return;
    if (typeof window === 'undefined') return;

    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) {
      setError('Токен не знайдено');
      return;
    }

    try {
      const url = `${API_URL}/api/dashboard/stream?token=${encodeURIComponent(token)}`;
      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        if (mountedRef.current) {
          setIsLive(true);
          setError(null);
        }
      };

      es.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const parsed = JSON.parse(event.data) as DashboardSummary;
          setData(parsed);
        } catch {
          // Silently ignore malformed SSE payloads — heartbeat / partial frames
          // may surface here under poor connectivity.
        }
      };

      es.onerror = () => {
        if (!mountedRef.current) return;
        setIsLive(false);
        setError('Відключено від сервера');
        es.close();

        // Reconnect after 5 seconds
        retryTimeoutRef.current = setTimeout(() => {
          if (mountedRef.current) {
            connectSSE();
          }
        }, 5000);
      };
    } catch (err) {
      if (mountedRef.current) {
        setError(`Помилка підключення: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connectSSE();

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
