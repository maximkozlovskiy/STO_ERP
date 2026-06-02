'use client';

import { useState, useCallback } from 'react';
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

  const mutate = useCallback(
    async (args: T) => {
      setSaving(true);
      setError('');
      try {
        const result = await mutationFn(args);
        if (options?.successMsg && features.toastEnabled) toast.success(options.successMsg);
        options?.onSuccess?.(result);
        return result;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : (options?.errorMsg ?? 'Помилка');
        setError(msg);
        if (features.toastEnabled) toast.error(msg);
        options?.onError?.(e instanceof Error ? e : new Error(msg));
        return undefined;
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mutationFn, features.toastEnabled],
  );

  return { mutate, saving, error, clearError: () => setError('') };
}
