'use client';

import { createContext, useContext, useEffect, useReducer, useCallback, type ReactNode } from 'react';
import type { AuthEmployee, AuthState } from './types';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
const TOKEN_KEY = 'sto_access_token';

// Bug #131: публічні роути НЕ повинні робити refresh-запит на mount —
// браузер логує 401 у console, що ламає console-errors.spec.ts і шумить у Sentry.
const PUBLIC_ROUTES = ['/login', '/setup', '/', '/403', '/booking'];

function isPublicPathname(pathname: string): boolean {
  return PUBLIC_ROUTES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
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
  refreshToken: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// ─── Provider ────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    employee: null,
    accessToken: null,
    isLoading: true,
  });

  const refreshToken = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) return false;
      const data = await res.json() as { accessToken: string; employee?: AuthEmployee };
      if (!data.accessToken) return false;

      const employee = data.employee ?? state.employee;
      if (!employee) return false;

      sessionStorage.setItem(TOKEN_KEY, data.accessToken);
      dispatch({ type: 'REFRESH_TOKEN', accessToken: data.accessToken, employee });
      return true;
    } catch {
      return false;
    }
  }, [state.employee]);

  // On mount — try to restore session via refresh cookie.
  // Bug #131: пропускаємо refresh на публічних роутах щоб не отримувати 401 console.error
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
      return () => { cancelled = true; };
    }

    if (stored) {
      // Token in sessionStorage — still need to get employee info via refresh
      refreshToken().then((ok) => {
        if (cancelled) return;
        if (!ok) {
          sessionStorage.removeItem(TOKEN_KEY);
          dispatch({ type: 'LOGOUT' });
          if (typeof window !== 'undefined') window.dispatchEvent(new Event('sto:logout'));
        }
      });
    } else {
      // Try silent refresh (cookie might still be valid)
      refreshToken().then((ok) => {
        if (cancelled) return;
        if (!ok) dispatch({ type: 'LOGOUT' });
      });
    }
    return () => { cancelled = true; };
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
      const err = await res.json().catch(() => ({ message: 'Помилка входу' })) as { message: string };
      throw new Error(err.message);
    }

    const data = await res.json() as { accessToken: string; employee: AuthEmployee };
    sessionStorage.setItem(TOKEN_KEY, data.accessToken);
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
      dispatch({ type: 'LOGOUT' });
      // Notify per-tenant client-side caches (UI features, etc.) to invalidate.
      // Prevents leak of previous user's settings into next session on shared kiosk.
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('sto:logout'));
    }
  }, [state.accessToken]);

  return (
    <AuthContext.Provider value={{ ...state, login, logout, refreshToken }}>
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
