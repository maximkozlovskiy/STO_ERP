'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSyncStatus, syncKeys } from '@/hooks/api/useSyncStatus';
import type { SyncRecord } from '@sto/shared';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { fmtDateTime } from '@/lib/format';

export default function SyncPage() {
  useRequireAuth(['OWNER', 'ADMIN']);
  const qc = useQueryClient();
  const { data: status, isLoading: loading, error: statusError } = useSyncStatus();
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState(statusError instanceof Error ? statusError.message : '');

  const triggerSync = async () => {
    setSyncing(true);
    setMsg('');
    setError('');
    try {
      const since = status?.maxSyncVersion ?? 0;
      // sto-optimize: pull and push are independent operations (web has no local
      // dirty records to push, so push is effectively a no-op acceptance count).
      // Promise.all collapses 2 sequential round-trips into one.
      const [pulled, pushResult] = await Promise.all([
        apiFetch<SyncRecord[]>(`/sync/pull?since=${since}`),
        apiFetch<{ accepted: number; conflicts: number }>('/sync/push', {
          method: 'POST',
          body: JSON.stringify({ records: [] }),
        }),
      ]);
      const pulledCount = Array.isArray(pulled) ? pulled.length : 0;

      setMsg(
        `Синхронізація завершена. Отримано ${pulledCount} записів. ` +
          `Відправлено: ${pushResult.accepted} прийнято, ${pushResult.conflicts} конфліктів.`,
      );
      qc.invalidateQueries({ queryKey: syncKeys.all });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка синхронізації');
    } finally {
      setSyncing(false);
    }
  };

  // Thin proxy to lib/format singleton — was inline `.toLocaleDateString` + `.toLocaleTimeString`
  // що конструювало два Intl форматери на кожен виклик у status grid.
  const fmtDate = (iso: string | null) => fmtDateTime(iso);

  return (
    <div className="page-container max-w-2xl">
      <h1 className="page-title mb-2">Cloud Sync</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Синхронізація між філіями та хмарний резервний бекап. Опціональна функція — система повністю
        працює без неї.
      </p>

      {msg && (
        <div className="mb-4 text-sm text-success bg-success-subtle border border-success/20 rounded-lg p-3">
          {msg}
        </div>
      )}
      {error && (
        <div className="mb-4 text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size="lg" />
        </div>
      ) : !status ? (
        <div className="text-center py-12 text-muted-foreground">
          Не вдалося завантажити статус синхронізації.
        </div>
      ) : (
        <>
          {/* Status cards */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div
              className={cn(
                'bg-surface rounded-xl border p-4',
                status.failedJobs > 0 ? 'border-destructive/30' : 'border-border',
              )}
            >
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                Помилки
              </div>
              <div
                className={cn(
                  'text-2xl font-bold',
                  status.failedJobs > 0 ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {status.failedJobs}
              </div>
            </div>
            <div
              className={cn(
                'bg-surface rounded-xl border p-4',
                status.pendingJobs > 0 ? 'border-warning/30' : 'border-border',
              )}
            >
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                Очікують
              </div>
              <div
                className={cn(
                  'text-2xl font-bold',
                  status.pendingJobs > 0 ? 'text-warning' : 'text-muted-foreground',
                )}
              >
                {status.pendingJobs}
              </div>
            </div>
          </div>

          <div className="bg-surface rounded-xl border border-border p-5 mb-6 space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Остання синхронізація</span>
              <span className="font-medium text-foreground">{fmtDate(status.lastSyncAt)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Поточна версія (syncVersion)</span>
              <span className="font-medium text-foreground font-mono">{status.maxSyncVersion}</span>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <div
                className={cn(
                  'w-2 h-2 rounded-full',
                  status.failedJobs > 0
                    ? 'bg-destructive'
                    : status.pendingJobs > 0
                      ? 'bg-warning'
                      : 'bg-success',
                )}
              />
              <span className="text-sm text-muted-foreground">
                {status.failedJobs > 0
                  ? 'Є помилки синхронізації — перевірте журнал'
                  : status.pendingJobs > 0
                    ? 'Є задачі в черзі'
                    : 'Все синхронізовано'}
              </span>
            </div>
          </div>

          <Button onClick={triggerSync} loading={syncing} className="w-full">
            ↻ Синхронізувати зараз
          </Button>

          <p className="mt-3 text-xs text-muted-foreground text-center">
            Автоматична синхронізація відбувається при наявності інтернет-з&apos;єднання
          </p>
        </>
      )}
    </div>
  );
}
