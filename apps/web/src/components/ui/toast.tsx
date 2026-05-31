'use client';

import { useEffect, useState } from 'react';
import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { subscribe, remove, type ToastItem, type ToastType } from '@/lib/toast';
import { cn } from '@/lib/utils';

const ICONS: Record<ToastType, typeof CheckCircle> = {
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};

const STYLES: Record<ToastType, string> = {
  success: 'bg-success-subtle border-success/30 text-success-text',
  error: 'bg-destructive-subtle border-destructive-border text-destructive-text',
  warning: 'bg-warning-subtle border-warning/30 text-warning-text',
  info: 'bg-info-subtle border-info/30 text-info-text',
};

const ICON_STYLES: Record<ToastType, string> = {
  success: 'text-success',
  error: 'text-destructive',
  warning: 'text-warning',
  info: 'text-info',
};

function Toast({ item }: { item: ToastItem }) {
  const [visible, setVisible] = useState(false);
  const Icon = ICONS[item.type];

  useEffect(() => {
    // Animate in
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  const handleClose = () => {
    setVisible(false);
    setTimeout(() => remove(item.id), 200);
  };

  return (
    <div
      className={cn(
        'flex items-start gap-3 px-4 py-3 rounded-xl border shadow-lg text-[13px] max-w-sm w-full',
        'transition-all duration-200',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2',
        STYLES[item.type],
      )}
      role="alert"
    >
      <Icon className={cn('h-4 w-4 shrink-0 mt-0.5', ICON_STYLES[item.type])} />
      <span className="flex-1 leading-snug">{item.message}</span>
      <button
        onClick={handleClose}
        className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
        aria-label="Закрити"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => subscribe(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="fixed top-4 right-4 z-200 flex flex-col gap-2 pointer-events-none"
    >
      {toasts.map(t => (
        <div key={t.id} className="pointer-events-auto">
          <Toast item={t} />
        </div>
      ))}
    </div>
  );
}
