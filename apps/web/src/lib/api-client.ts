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
    const data = await res.json() as { accessToken?: string };
    if (data.accessToken) {
      setToken(data.accessToken);
      return data.accessToken;
    }
    return null;
  } catch {
    return null;
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = getToken();

  const makeRequest = (accessToken: string | null) =>
    fetch(`${API_URL}/api${path}`, {
      credentials: 'include',
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...init?.headers,
      },
    });

  let res = await makeRequest(token);

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
    }
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText })) as { message: string };
    throw new Error(error.message);
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}
