import { useState, useCallback } from 'react';

interface UseOptimisticMutationOptions<T> {
  /** Produces the optimistic (pre-server) version of state */
  onOptimisticUpdate: (current: T) => T;
  /** Called after rollback (optional) */
  onRollback?: (previous: T) => void;
  /** Called on server success (optional) */
  onSuccess?: (result: unknown, previous: T) => void;
  /** Called on server error after rollback (optional) */
  onError?: (error: Error, previous: T) => void;
}

/**
 * Optimistic mutation hook.
 *
 * Immediately applies `onOptimisticUpdate` to the state, fires the async
 * `mutationFn`, and rolls back to the previous state on failure.
 *
 * Usage:
 * ```ts
 * const { mutate, isPending } = useOptimisticMutation(
 *   status, setStatus,
 *   () => apiFetch('/work-orders/123/transition', { method: 'POST', body: ... }),
 *   { onOptimisticUpdate: () => 'IN_PROGRESS' },
 * );
 * ```
 */
export function useOptimisticMutation<T>(
  state: T,
  setState: (value: T) => void,
  mutationFn: () => Promise<unknown>,
  options: UseOptimisticMutationOptions<T>,
) {
  const [isPending, setIsPending] = useState(false);

  const mutate = useCallback(async () => {
    const previous = state;
    setState(options.onOptimisticUpdate(previous));
    setIsPending(true);
    try {
      const result = await mutationFn();
      options.onSuccess?.(result, previous);
    } catch (err) {
      setState(previous);
      options.onRollback?.(previous);
      options.onError?.(err instanceof Error ? err : new Error(String(err)), previous);
    } finally {
      setIsPending(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, setState, mutationFn, options]);

  return { mutate, isPending };
}
