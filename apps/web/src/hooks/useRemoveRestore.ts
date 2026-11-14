import { useCallback, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import type { ConfirmOptions } from '@/hooks/useConfirm';

interface RemoveRestoreOptions {
  /** Шлях ресурсу без id: `/brands` → `DELETE /brands/:id`, `POST /brands/:id/restore`. */
  basePath: string;
  /** Підтвердження видалення (`useConfirm().confirm`). */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** Перечитати список (і кеш довідника) після успішного видалення чи відновлення. */
  afterChange: () => void;
  /** Банер помилки вкладки; `''` — зняти попередню перед новою дією. */
  setError: (message: string) => void;
  /** Текст помилки, коли відповідь не дала власного. */
  fallbackError: { remove: string; restore: string };
}

/**
 * Видалення (з підтвердженням) і відновлення рядка довідника — один шлях для вкладок каталогу.
 * Тримає стан «видаляється» / «відновлюється» і блокує повторний клік: другий POST restore
 * повертав 404 і хибну помилку в UI (перший уже зняв `deletedAt`).
 */
export function useRemoveRestore({
  basePath,
  confirm,
  afterChange,
  setError,
  fallbackError,
}: RemoveRestoreOptions) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [restoringIds, setRestoringIds] = useState<Set<string>>(new Set());
  // Ref, а не стан: два кліки в одному кадрі бачать той самий застарілий `restoringIds`.
  const inFlight = useRef(new Set<string>());

  const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

  const remove = useCallback(
    async (id: string, confirmOptions: ConfirmOptions, onRemoved?: () => void) => {
      if (!(await confirm(confirmOptions))) return;
      setDeletingId(id);
      setError('');
      try {
        await apiFetch<void>(`${basePath}/${id}`, { method: 'DELETE' });
        onRemoved?.();
        afterChange();
      } catch (e: unknown) {
        setError(errorText(e, fallbackError.remove));
      } finally {
        setDeletingId(null);
      }
    },
    [basePath, confirm, afterChange, setError, fallbackError.remove],
  );

  const restore = useCallback(
    async <R = unknown>(
      id: string,
      opts?: { successToast?: string; onRestored?: (restored: R) => void },
    ) => {
      if (inFlight.current.has(id)) return;
      inFlight.current.add(id);
      setError('');
      setRestoringIds(prev => new Set(prev).add(id));
      try {
        const restored = await apiFetch<R>(`${basePath}/${id}/restore`, { method: 'POST' });
        opts?.onRestored?.(restored);
        afterChange();
        if (opts?.successToast) toast.success(opts.successToast);
      } catch (e: unknown) {
        setError(errorText(e, fallbackError.restore));
      } finally {
        inFlight.current.delete(id);
        setRestoringIds(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [basePath, afterChange, setError, fallbackError.restore],
  );

  return { deletingId, restoringIds, remove, restore };
}
