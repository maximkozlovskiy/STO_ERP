import { apiFetch, setToken } from './api';

let currentToken: string | null = null;

export function getToken() { return currentToken; }

export async function login(email: string, password: string): Promise<string> {
  const res = await apiFetch<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  currentToken = res.accessToken;
  setToken(currentToken);
  return currentToken;
}

export function logout() {
  currentToken = null;
  setToken(null);
}
