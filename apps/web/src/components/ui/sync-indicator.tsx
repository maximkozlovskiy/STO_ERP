'use client';

import { useEffect, useState } from 'react';
import { Cloud, CloudOff, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtTime } from '@/lib/format';

type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

export function SyncIndicator() {
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [pendingOps, setPendingOps] = useState(0);

  useEffect(() => {
    const onOnline = () => {
      setStatus('idle');
      // Clear pending counter when back online (ops will be retried by user)
      localStorage.setItem('sto_pending_ops', '0');
      setPendingOps(0);
    };
    const onOffline = () => setStatus('offline');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    if (!navigator.onLine) setStatus('offline');
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    const onSync = (e: Event) => {
      const detail = (e as CustomEvent<{ status: SyncStatus }>).detail;
      setStatus(detail.status);
      if (detail.status === 'idle') setLastSync(new Date());
    };
    window.addEventListener('sto:sync-status', onSync);
    return () => window.removeEventListener('sto:sync-status', onSync);
  }, []);

  // F11: track pending offline operations counter
  useEffect(() => {
    const updatePending = () => {
      setPendingOps(Number(localStorage.getItem('sto_pending_ops') ?? '0'));
    };
    updatePending();
    window.addEventListener('sto:pending-ops-changed', updatePending);
    return () => {
      window.removeEventListener('sto:pending-ops-changed', updatePending);
    };
  }, []);

  if (status === 'idle' && !lastSync) return null;

  const isOffline = status === 'offline';

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-colors',
        status === 'idle' && 'text-success',
        status === 'syncing' && 'text-info',
        status === 'offline' && 'text-warning',
        status === 'error' && 'text-destructive',
      )}
      title={lastSync ? `Синхронізовано: ${fmtTime(lastSync)}` : undefined}
    >
      {status === 'syncing' ? (
        <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : isOffline ? (
        <CloudOff className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Cloud className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      <span className="hidden sm:inline">
        {status === 'syncing'
          ? 'Синхронізація...'
          : isOffline
            ? pendingOps > 0
              ? `${pendingOps} змін очікують`
              : 'Офлайн'
            : status === 'error'
              ? 'Помилка'
              : 'Синхронізовано'}
      </span>
    </div>
  );
}
