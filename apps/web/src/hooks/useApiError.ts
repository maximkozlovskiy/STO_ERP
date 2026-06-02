'use client';

import { useState, useCallback } from 'react';

export function parseApiError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'Невідома помилка';
}

export function useApiError(initial = '') {
  const [error, setError] = useState(initial);
  const handleError = useCallback((e: unknown) => setError(parseApiError(e)), []);
  const clearError = useCallback(() => setError(''), []);
  return { error, setError, handleError, clearError };
}
