'use client';

import { TOKEN_KEY } from './auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(TOKEN_KEY);
}

function setToken(token: string): void {
  if (typeof window !== 'undefined') sessionStorage.setItem(TOKEN_KEY, token);
}

function clearToken(): void {
  if (typeof window !== 'undefined') sessionStorage.removeItem(TOKEN_KEY);
}

async function tryRefresh(): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { accessToken?: string };
    if (data.accessToken) {
      setToken(data.accessToken);
      return data.accessToken;
    }
    return null;
  } catch {
    return null;
  }
}

// Dedup identical in-flight GET requests — prevents double-fetch on StrictMode
// double-invoke and rapid UI interactions hitting the same endpoint.
const inFlight = new Map<string, Promise<unknown>>();

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  // Only dedup plain GETs. A request carrying an AbortSignal must NOT share a promise:
  // if caller A aborts, the underlying fetch rejects and that rejection would wrongly
  // propagate to caller B who never aborted. Such callers always run their own fetch.
  if (method === 'GET' && !init?.signal) {
    const key = path;
    const existing = inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = _apiFetch<T>(path, init).finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }
  return _apiFetch<T>(path, init);
}

async function _apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();

  // Only add Content-Type: application/json when there is a body to send.
  // Sending Content-Type: application/json with an empty body causes Fastify to
  // attempt JSON parsing → SyntaxError → 500 (e.g. PATCH /booking/:id/confirm).
  const hasBody = init?.body != null;
  const makeRequest = (accessToken: string | null) =>
    fetch(`${API_URL}/api${path}`, {
      credentials: 'include',
      ...init,
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...init?.headers,
      },
    });

  let res: Response;
  try {
    res = await makeRequest(token);
  } catch (networkErr) {
    // Network failure (offline) — increment pending counter
    if (typeof window !== 'undefined' && !navigator.onLine) {
      const count = Number(localStorage.getItem('sto_pending_ops') ?? '0');
      localStorage.setItem('sto_pending_ops', String(count + 1));
      window.dispatchEvent(new CustomEvent('sto:pending-ops-changed'));
    }
    throw networkErr;
  }

  // Silent token refresh on 401
  if (res.status === 401) {
    const newToken = await tryRefresh();
    if (newToken) {
      res = await makeRequest(newToken);
    } else {
      clearToken();
      if (typeof window !== 'undefined') {
        window.location.replace('/login');
      }
      return undefined as T;
    }
  }

  if (!res.ok) {
    // Server error (503 etc.) while offline — increment pending counter
    if (typeof window !== 'undefined' && !navigator.onLine) {
      const count = Number(localStorage.getItem('sto_pending_ops') ?? '0');
      localStorage.setItem('sto_pending_ops', String(count + 1));
      window.dispatchEvent(new CustomEvent('sto:pending-ops-changed'));
    }
    const error = (await res.json().catch(() => ({ message: res.statusText }))) as {
      message: string | string[];
    };
    const msg = Array.isArray(error.message)
      ? error.message.join('; ')
      : (error.message ?? res.statusText);
    throw new Error(msg);
  }

  // Successful request — decrement pending counter if any were queued
  if (typeof window !== 'undefined') {
    const pending = Number(localStorage.getItem('sto_pending_ops') ?? '0');
    if (pending > 0) {
      localStorage.setItem('sto_pending_ops', String(pending - 1));
      window.dispatchEvent(new CustomEvent('sto:pending-ops-changed'));
    }
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;

  return (await res.json()) as T;
}

/**
 * Bug #77: PDF/blob downloads must also do silent refresh on 401.
 * Same auth/refresh logic as `apiFetch`, but returns a `Blob` (no JSON parsing).
 */
export async function apiBlobFetch(path: string, init?: RequestInit): Promise<Blob> {
  const token = getToken();

  const makeRequest = (accessToken: string | null) =>
    fetch(`${API_URL}/api${path}`, {
      credentials: 'include',
      ...init,
      headers: {
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...init?.headers,
      },
    });

  let res = await makeRequest(token);

  if (res.status === 401) {
    const newToken = await tryRefresh();
    if (newToken) {
      res = await makeRequest(newToken);
    } else {
      clearToken();
      if (typeof window !== 'undefined') {
        window.location.replace('/login');
      }
      throw new Error('Сесія застаріла, увійдіть знову');
    }
  }

  if (!res.ok) {
    // Try to parse error body as JSON (most likely shape from NestJS) — fall back to status text.
    // NestJS class-validator returns `message: string[]` on 400 → join with '; '.
    const errBody = (await res
      .json()
      .catch(() => ({ message: `Помилка завантаження файлу (${res.status})` }))) as {
      message?: string | string[];
    };
    const errMsg = Array.isArray(errBody.message)
      ? errBody.message.join('; ')
      : (errBody.message ?? `Помилка завантаження файлу (${res.status})`);
    throw new Error(errMsg);
  }

  return await res.blob();
}

/**
 * Bug #85: multipart/form-data upload з silent refresh.
 * `apiFetch` фіксує Content-Type=application/json — не підходить для FormData.
 * Browser сам додасть `multipart/form-data; boundary=...` — НЕ задавай Content-Type вручну.
 */
export async function apiMultipartFetch<T>(
  path: string,
  formData: FormData,
  init?: Omit<RequestInit, 'body' | 'headers'>,
): Promise<T> {
  const token = getToken();

  const makeRequest = (accessToken: string | null) =>
    fetch(`${API_URL}/api${path}`, {
      method: 'POST',
      credentials: 'include',
      ...init,
      headers: {
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: formData,
    });

  let res = await makeRequest(token);

  if (res.status === 401) {
    const newToken = await tryRefresh();
    if (newToken) {
      res = await makeRequest(newToken);
    } else {
      clearToken();
      if (typeof window !== 'undefined') {
        window.location.replace('/login');
      }
      throw new Error('Сесія застаріла, увійдіть знову');
    }
  }

  if (!res.ok) {
    // NestJS class-validator returns `message: string[]` on 400 → join with '; '.
    const errBody = (await res
      .json()
      .catch(() => ({ message: `Помилка завантаження (${res.status})` }))) as {
      message?: string | string[];
    };
    const errMsg = Array.isArray(errBody.message)
      ? errBody.message.join('; ')
      : (errBody.message ?? `Помилка завантаження (${res.status})`);
    throw new Error(errMsg);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Bug #292/#293: публічні сторінки (`/`, `/setup`, `/booking`, `/login`, `/403`) НЕ повинні
 * використовувати `apiFetch` — той надсилає Authorization header зі stale токена і при 401
 * робить `window.location.replace('/login')`. Це ламає setup wizard / root redirect logic.
 *
 * `publicFetch` шле raw `fetch` БЕЗ Authorization, БЕЗ refresh, БЕЗ auto-redirect.
 * Використовувати тільки для публічних endpoint-ів (`/setup/status`, `/setup/init`, `/booking/*`).
 */
export async function publicFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body != null;
  const res = await fetch(`${API_URL}/api${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (!res.ok) {
    // NestJS class-validator повертає `message: string[]` при 400 — join '; '.
    const body = (await res.json().catch(() => ({ message: res.statusText }))) as {
      message?: string | string[];
    };
    const msg = Array.isArray(body.message)
      ? body.message.join('; ')
      : (body.message ?? `HTTP ${res.status}`);
    throw new Error(msg);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
