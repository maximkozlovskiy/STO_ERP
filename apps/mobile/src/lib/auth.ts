import * as SecureStore from 'expo-secure-store';
import { apiFetch, setToken } from './api';

const TOKEN_KEY = 'sto_access_token';

export async function loadToken(): Promise<string | null> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  if (token) setToken(token);
  return token;
}

export async function login(email: string, password: string): Promise<string> {
  const res = await apiFetch<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  await SecureStore.setItemAsync(TOKEN_KEY, res.accessToken);
  setToken(res.accessToken);
  return res.accessToken;
}

export async function logout(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  setToken(null);
}
