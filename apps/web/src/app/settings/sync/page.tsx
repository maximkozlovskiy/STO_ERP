'use client';

import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';

interface SyncRecord {
  table: string;
  id: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  syncVersion: number;
  payload: Record<string, unknown>;
}

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
    } catch {
      setError('Не вдалося отримати статус синхронізації');
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
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Cloud Sync</h1>
      <p className="text-sm text-gray-500 mb-6">
        Синхронізація між філіями та хмарний резервний бекап. Опціональна функція — система повністю працює без неї.
      </p>

      {msg && (
        <div className="mb-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-3">{msg}</div>
      )}
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Завантаження...</div>
      ) : status && (
        <>
          {/* Status cards */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className={`bg-white rounded-xl border p-4 ${status.failedJobs > 0 ? 'border-red-200' : 'border-gray-200'}`}>
              <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">Помилки</div>
              <div className={`text-2xl font-bold ${status.failedJobs > 0 ? 'text-red-600' : 'text-gray-500'}`}>
                {status.failedJobs}
              </div>
            </div>
            <div className={`bg-white rounded-xl border p-4 ${status.pendingJobs > 0 ? 'border-amber-200' : 'border-gray-200'}`}>
              <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">Очікують</div>
              <div className={`text-2xl font-bold ${status.pendingJobs > 0 ? 'text-amber-600' : 'text-gray-500'}`}>
                {status.pendingJobs}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6 space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Остання синхронізація</span>
              <span className="font-medium text-gray-900">{fmtDate(status.lastSyncAt)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Поточна версія (syncVersion)</span>
              <span className="font-medium text-gray-900 font-mono">{status.maxSyncVersion}</span>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <div className={`w-2 h-2 rounded-full ${status.failedJobs > 0 ? 'bg-red-500' : status.pendingJobs > 0 ? 'bg-amber-500' : 'bg-green-500'}`} />
              <span className="text-sm text-gray-600">
                {status.failedJobs > 0
                  ? 'Є помилки синхронізації — перевірте журнал'
                  : status.pendingJobs > 0
                    ? 'Є задачі в черзі'
                    : 'Все синхронізовано'}
              </span>
            </div>
          </div>

          <button
            onClick={triggerSync}
            disabled={syncing}
            className="w-full py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60 transition-colors"
          >
            {syncing ? 'Синхронізація...' : '↻ Синхронізувати зараз'}
          </button>

          <p className="mt-3 text-xs text-gray-400 text-center">
            Автоматична синхронізація відбувається при наявності інтернет-з'єднання
          </p>
        </>
      )}
    </div>
  );
}
