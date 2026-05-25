'use client';

import { useEffect, useState } from 'react';
import type { SyncRecord } from '@sto/shared';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

interface SyncStatus {
  pendingJobs: number;
  failedJobs: number;
  lastSyncAt: string | null;
  maxSyncVersion: number;
}

export default function SyncPage() {
  useRequireAuth(['OWNER', 'ADMIN']);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const loadStatus = async () => {
    try {
      const s = await apiFetch<SyncStatus>('/sync/status');
      setStatus(s);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Не вдалося отримати статус синхронізації');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadStatus(); }, []);

  const triggerSync = async () => {
    setSyncing(true);
    setMsg('');
    setError('');
    try {
      const since = status?.maxSyncVersion ?? 0;
      const pulled = await apiFetch<SyncRecord[]>(`/sync/pull?since=${since}`);
      const pulledCount = Array.isArray(pulled) ? pulled.length : 0;

      const pushResult = await apiFetch<{ accepted: number; conflicts: number }>('/sync/push', {
        method: 'POST',
        body: JSON.stringify({ records: [] }), // web client has no local dirty records to push
      });

      setMsg(
        `Синхронізація завершена. Отримано ${pulledCount} записів. ` +
        `Відправлено: ${pushResult.accepted} прийнято, ${pushResult.conflicts} конфліктів.`,
      );
      await loadStatus();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка синхронізації');
    } finally {
      setSyncing(false);
    }
  };

  const fmtDate = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="page-container max-w-2xl">
      <h1 className="page-title mb-2">Cloud Sync</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Синхронізація між філіями та хмарний резервний бекап. Опціональна функція — система повністю працює без неї.
      </p>

      {msg && (
        <div className="mb-4 text-sm text-success bg-success-subtle border border-success/20 rounded-lg p-3">{msg}</div>
      )}
      {error && (
        <div className="mb-4 text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">{error}</div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size="lg" />
        </div>
      ) : !status ? (
        <div className="text-center py-12 text-muted-foreground">Не вдалося завантажити статус синхронізації.</div>
      ) : (
        <>
          {/* Status cards */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className={cn('bg-surface rounded-xl border p-4', status.failedJobs > 0 ? 'border-destructive/30' : 'border-border')}>
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Помилки</div>
              <div className={cn('text-2xl font-bold', status.failedJobs > 0 ? 'text-destructive' : 'text-muted-foreground')}>
                {status.failedJobs}
              </div>
            </div>
            <div className={cn('bg-surface rounded-xl border p-4', status.pendingJobs > 0 ? 'border-warning/30' : 'border-border')}>
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Очікують</div>
              <div className={cn('text-2xl font-bold', status.pendingJobs > 0 ? 'text-warning' : 'text-muted-foreground')}>
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
              <div className={cn(
                'w-2 h-2 rounded-full',
                status.failedJobs > 0 ? 'bg-destructive' : status.pendingJobs > 0 ? 'bg-warning' : 'bg-success',
              )} />
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
