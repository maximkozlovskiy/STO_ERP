'use client';

import { useEffect, useState } from 'react';
import { Cloud, CloudOff, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

export function SyncIndicator() {
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [lastSync, setLastSync] = useState<Date | null>(null);

  useEffect(() => {
    const onOnline  = () => setStatus('idle');
    const onOffline = () => setStatus('offline');
    window.addEventListener('online',  onOnline);
    window.addEventListener('offline', onOffline);
    if (!navigator.onLine) setStatus('offline');
    return () => {
      window.removeEventListener('online',  onOnline);
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

  if (status === 'idle' && !lastSync) return null;

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-colors',
        status === 'idle'    && 'text-success',
        status === 'syncing' && 'text-info',
        status === 'offline' && 'text-warning',
        status === 'error'   && 'text-destructive',
      )}
      title={lastSync ? `Синхронізовано: ${lastSync.toLocaleTimeString('uk-UA')}` : undefined}
    >
      {status === 'syncing' ? (
        <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : status === 'offline' ? (
        <CloudOff className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Cloud className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      <span className="hidden sm:inline">
        {status === 'syncing' ? 'Синхронізація...' : status === 'offline' ? 'Офлайн' : status === 'error' ? 'Помилка' : 'Синхронізовано'}
      </span>
    </div>
  );
}
