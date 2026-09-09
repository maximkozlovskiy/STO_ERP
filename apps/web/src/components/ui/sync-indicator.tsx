'use client';

import { useEffect, useState } from 'react';
import { Cloud, CloudOff, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtTime } from '@/lib/format';

type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

// T3: STO ERP працює у локальній мережі без інтернету, але НЕ має offline-write-черги — при втраті
// зв'язку з локальним API запис недоступний (не «накопичується для синхронізації»). Індикатор чесно
// показує «Офлайн — збереження недоступне», а не фейковий лічильник «N змін очікують».
export function SyncIndicator() {
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [lastSync, setLastSync] = useState<Date | null>(null);

  useEffect(() => {
    const onOnline = () => setStatus('idle');
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
      title={
        isOffline
          ? 'Немає зв’язку з сервером СТО — збереження недоступне до відновлення мережі'
          : lastSync
            ? `Синхронізовано: ${fmtTime(lastSync)}`
            : undefined
      }
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
            ? 'Офлайн — збереження недоступне'
            : status === 'error'
              ? 'Помилка'
              : 'Синхронізовано'}
      </span>
    </div>
  );
}
