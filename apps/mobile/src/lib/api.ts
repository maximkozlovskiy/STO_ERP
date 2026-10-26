import { Platform } from 'react-native';

// На Android емуляторі 10.0.2.2 = localhost хосту
// На фізичному пристрої — IP локального сервера
// API-версіонування (backend #3): бізнес-роути під /api/v1 (health/public — version-neutral, /api/...).
const BASE_URL = Platform.select({
  android: 'http://10.0.2.2:3000/api/v1',
  default: 'http://localhost:3000/api/v1',
});

let accessToken: string | null = null;

export function setToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/**
 * Відповідь сервера з кодом помилки. Відрізняє «сервер відхилив» (є `status`) від «сервер
 * недосяжний» (`fetch` кидає TypeError ще до відповіді) — офлайн-синхронізація тримає зміну
 * до наступної спроби лише в другому випадку.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Немає зв'язку з сервером (запит не дійшов або відповідь не прийшла). */
export function isNetworkError(e: unknown): boolean {
  return !(e instanceof ApiError);
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string>),
  };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const message =
      body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
        ? body.message
        : `HTTP ${res.status}`;
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json();
}
