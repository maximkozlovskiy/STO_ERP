'use client';

import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useCallback,
  type ReactNode,
} from 'react';
import type { AuthEmployee, AuthState } from './types';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
const TOKEN_KEY = 'sto_access_token';

// публічні роути НЕ повинні робити refresh-запит на mount —
// браузер логує 401 у console, що ламає console-errors.spec.ts і шумить у Sentry.
// експортується тут як SSOT, TopShell використовує isPublicRoute з цього модуля.
export const PUBLIC_ROUTES = ['/login', '/setup', '/', '/403', '/booking'] as const;

export function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some(p => pathname === p || pathname.startsWith(`${p}/`));
}

function isPublicPathname(pathname: string): boolean {
  return isPublicRoute(pathname);
}

// ─── State ───────────────────────────────────────────────

type Action =
  | { type: 'LOGIN'; employee: AuthEmployee; accessToken: string }
  | { type: 'LOGOUT' }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'REFRESH_TOKEN'; accessToken: string; employee: AuthEmployee };

function reducer(state: AuthState, action: Action): AuthState {
  switch (action.type) {
    case 'LOGIN':
      return { employee: action.employee, accessToken: action.accessToken, isLoading: false };
    case 'LOGOUT':
      return { employee: null, accessToken: null, isLoading: false };
    case 'SET_LOADING':
      return { ...state, isLoading: action.loading };
    case 'REFRESH_TOKEN':
      return { employee: action.employee, accessToken: action.accessToken, isLoading: false };
    default:
      return state;
  }
}

// ─── Context ─────────────────────────────────────────────

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** B1: вийти на ВСІХ пристроях — інвалідує всі сесії через bump tokenVersion на бекенді. */
  logoutAll: () => Promise<void>;
  refreshToken: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const EMPLOYEE_CACHE_KEY = 'sto_employee_cache';

function readCachedEmployee(): AuthEmployee | null {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(EMPLOYEE_CACHE_KEY) : null;
    return raw ? (JSON.parse(raw) as AuthEmployee) : null;
  } catch {
    return null;
  }
}

function writeCachedEmployee(employee: AuthEmployee | null) {
  try {
    if (employee) {
      localStorage.setItem(EMPLOYEE_CACHE_KEY, JSON.stringify(employee));
    } else {
      localStorage.removeItem(EMPLOYEE_CACHE_KEY);
    }
  } catch {
    /* ignore */
  }
}

// ─── Provider ────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  // Optimistic init: if employee is cached in localStorage + token in sessionStorage,
  // start with isLoading=false so TopShell renders immediately.
  // Refresh still runs in the background to validate the session.
  const [state, dispatch] = useReducer(
    reducer,
    (() => {
      // Playwright storageState restores localStorage automatically but NOT
      // sessionStorage (known limitation). For E2E we mirror access token into localStorage
      // under sto_e2e_access_token; AuthProvider hydrates sessionStorage from it on mount.
      let stored: string | null = null;
      if (typeof window !== 'undefined') {
        stored = sessionStorage.getItem(TOKEN_KEY);
        if (!stored && localStorage.getItem('sto_e2e_skip_refresh') === '1') {
          const fromLocal = localStorage.getItem('sto_e2e_access_token');
          if (fromLocal) {
            sessionStorage.setItem(TOKEN_KEY, fromLocal);
            stored = fromLocal;
          }
        }
      }
      const cached = readCachedEmployee();
      if (stored && cached) {
        return { employee: cached, accessToken: stored, isLoading: false };
      }
      return { employee: null, accessToken: null, isLoading: true };
    })(),
  );

  const refreshToken = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { accessToken: string; employee?: AuthEmployee };
      if (!data.accessToken) return false;

      const employee = data.employee ?? state.employee;
      if (!employee) return false;

      sessionStorage.setItem(TOKEN_KEY, data.accessToken);
      writeCachedEmployee(employee);
      dispatch({ type: 'REFRESH_TOKEN', accessToken: data.accessToken, employee });
      return true;
    } catch {
      return false;
    }
  }, [state.employee]);

  // On mount — try to restore session via refresh cookie.
  // пропускаємо refresh на публічних роутах щоб не отримувати 401 console.error
  // коли користувач свідомо відкрив /login або /setup без сесії.
  useEffect(() => {
    let cancelled = false;
    const pathname = typeof window !== 'undefined' ? window.location.pathname : '';
    const isPublic = isPublicPathname(pathname);
    const stored = sessionStorage.getItem(TOKEN_KEY);

    if (isPublic && !stored) {
      // Публічна сторінка + немає stored token — користувач не авторизований і це OK.
      // Просто завершуємо loading без HTTP запиту.
      dispatch({ type: 'LOGOUT' });
      return () => {
        cancelled = true;
      };
    }

    if (stored) {
      // E2E escape hatch. globalSetup cannot capture sto_refresh
      // cookie because it's path-scoped to /api/auth on a different port (3000 vs 3001
      // baseURL) and sameSite=strict — Playwright storageState skips it. Without this
      // flag every E2E test triggers refresh-on-mount → 401 → silent LOGOUT → /login
      // redirect, even though the access token cached in sessionStorage is still valid.
      const cached = readCachedEmployee();
      const e2eSkipRefresh =
        typeof window !== 'undefined' &&
        localStorage.getItem('sto_e2e_skip_refresh') === '1' &&
        !!cached;
      if (e2eSkipRefresh) {
        // Trust the cached employee + access token; skip background refresh.
        return () => {
          cancelled = true;
        };
      }
      // Token in sessionStorage — still need to get employee info via refresh
      refreshToken().then(ok => {
        if (cancelled) return;
        if (!ok) {
          sessionStorage.removeItem(TOKEN_KEY);
          writeCachedEmployee(null);
          dispatch({ type: 'LOGOUT' });
          if (typeof window !== 'undefined') window.dispatchEvent(new Event('sto:logout'));
        }
      });
    } else {
      // Try silent refresh (cookie might still be valid)
      refreshToken().then(ok => {
        if (cancelled) return;
        if (!ok) dispatch({ type: 'LOGOUT' });
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<void> => {
    const res = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      // NestJS class-validator повертає `message: string[]` при 400 — join з '; '.
      const err = (await res.json().catch(() => ({ message: 'Помилка входу' }))) as {
        message: string | string[];
      };
      const msg = Array.isArray(err.message)
        ? err.message.join('; ')
        : (err.message ?? 'Помилка входу');
      throw new Error(msg);
    }

    const data = (await res.json()) as { accessToken: string; employee: AuthEmployee };
    sessionStorage.setItem(TOKEN_KEY, data.accessToken);
    writeCachedEmployee(data.employee);
    dispatch({ type: 'LOGIN', employee: data.employee, accessToken: data.accessToken });
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('sto:login'));
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await fetch(`${API_URL}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${state.accessToken ?? ''}`,
        },
      });
    } finally {
      sessionStorage.removeItem(TOKEN_KEY);
      writeCachedEmployee(null);
      dispatch({ type: 'LOGOUT' });
      // Notify per-tenant client-side caches (UI features, etc.) to invalidate.
      // Prevents leak of previous user's settings into next session on shared kiosk.
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('sto:logout'));
    }
  }, [state.accessToken]);

  const logoutAll = useCallback(async (): Promise<void> => {
    try {
      // B1: bump tokenVersion на бекенді → усі раніше видані токени (усіх пристроїв) мертві.
      await fetch(`${API_URL}/api/auth/logout-all`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${state.accessToken ?? ''}`,
        },
      });
    } finally {
      sessionStorage.removeItem(TOKEN_KEY);
      writeCachedEmployee(null);
      dispatch({ type: 'LOGOUT' });
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('sto:logout'));
    }
  }, [state.accessToken]);

  return (
    <AuthContext.Provider value={{ ...state, login, logout, logoutAll, refreshToken }}>
      {children}
    </AuthContext.Provider>
  );
}

// ─── Hook ────────────────────────────────────────────────

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export { TOKEN_KEY };
