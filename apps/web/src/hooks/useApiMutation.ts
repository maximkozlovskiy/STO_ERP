'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { toast } from '@/lib/toast';
import { useUiFeatures } from './useUiFeatures';

export interface UseApiMutationOptions<R> {
  onSuccess?: (result: R) => void;
  onError?: (error: Error) => void;
  successMsg?: string;
  errorMsg?: string;
}

export function useApiMutation<T, R = unknown>(
  mutationFn: (args: T) => Promise<R>,
  options?: UseApiMutationOptions<R>,
) {
  const features = useUiFeatures();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Latest-ref pattern: keep `options` and `mutationFn` references current
  // without re-creating `mutate` on every parent render. Without this,
  // either the callback identity churns (breaks downstream memo) OR — if
  // omitted from deps — `onSuccess` reads a stale closure captured at mount.
  const optionsRef = useRef(options);
  const mutationFnRef = useRef(mutationFn);
  useEffect(() => {
    optionsRef.current = options;
    mutationFnRef.current = mutationFn;
  });

  const mutate = useCallback(
    async (args: T) => {
      setSaving(true);
      setError('');
      const opts = optionsRef.current;
      try {
        const result = await mutationFnRef.current(args);
        if (opts?.successMsg && features.toastEnabled) toast.success(opts.successMsg);
        opts?.onSuccess?.(result);
        return result;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : (opts?.errorMsg ?? 'Помилка');
        setError(msg);
        if (features.toastEnabled) toast.error(msg);
        opts?.onError?.(e instanceof Error ? e : new Error(msg));
        return undefined;
      } finally {
        setSaving(false);
      }
    },
    [features.toastEnabled],
  );

  const clearError = useCallback(() => setError(''), []);
  return { mutate, saving, error, clearError };
}
