'use client';

import { useEffect, useState, useCallback } from 'react';
import { Bell, X, CheckCheck, Info, AlertTriangle, CheckCircle, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtTime } from '@/lib/format';

export type NotifType = 'info' | 'success' | 'warning' | 'error';

export interface AppNotification {
  id: string;
  type: NotifType;
  title: string;
  body?: string;
  createdAt: number;
  read: boolean;
}

const STORAGE_KEY = 'sto_notifications';
const MAX_STORED = 50;

const ICONS: Record<NotifType, typeof Info> = {
  info: Info,
  success: CheckCircle,
  warning: AlertTriangle,
  error: AlertCircle,
};
const ICON_STYLES: Record<NotifType, string> = {
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-destructive',
};

function readStored(): AppNotification[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStored(items: AppNotification[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_STORED)));
  } catch {
    /* ignore */
  }
}

export function useNotifications() {
  const [items, setItems] = useState<AppNotification[]>([]);

  useEffect(() => {
    setItems(readStored());
  }, []);

  const add = useCallback((type: NotifType, title: string, body?: string) => {
    const n: AppNotification = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      title,
      body,
      createdAt: Date.now(),
      read: false,
    };
    setItems(prev => {
      const next = [n, ...prev].slice(0, MAX_STORED);
      writeStored(next);
      return next;
    });
    window.dispatchEvent(new CustomEvent('sto:notification-add', { detail: n }));
  }, []);

  const markRead = useCallback((id: string) => {
    setItems(prev => {
      const next = prev.map(n => (n.id === id ? { ...n, read: true } : n));
      writeStored(next);
      return next;
    });
  }, []);

  const markAllRead = useCallback(() => {
    setItems(prev => {
      const next = prev.map(n => ({ ...n, read: true }));
      writeStored(next);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setItems(prev => {
      const next = prev.filter(n => n.id !== id);
      writeStored(next);
      return next;
    });
  }, []);

  const unreadCount = items.filter(n => !n.read).length;
  return { items, add, markRead, markAllRead, remove, unreadCount };
}

interface NotificationCenterProps {
  enabled: boolean;
}

export function NotificationCenter({ enabled }: NotificationCenterProps) {
  const [open, setOpen] = useState(false);
  const { items, markRead, markAllRead, remove, unreadCount } = useNotifications();

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const el = document.getElementById('sto-notif-panel');
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!enabled) return null;

  return (
    <div className="relative" id="sto-notif-panel">
      <button
        onClick={() => setOpen(v => !v)}
        className="relative flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-muted hover:text-white hover:bg-sidebar-hover transition-colors"
        aria-label={`Сповіщення${unreadCount > 0 ? ` (${unreadCount} непрочитаних)` : ''}`}
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-white text-[9px] font-bold">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-full bottom-0 ml-2 w-80 bg-surface border border-border rounded-xl shadow-2xl z-250 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <span className="text-[13px] font-semibold text-foreground">Сповіщення</span>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Всі прочитано
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto divide-y divide-border">
            {items.length === 0 ? (
              <p className="py-8 text-center text-[13px] text-muted-foreground">Немає сповіщень</p>
            ) : (
              items.map(n => {
                const Icon = ICONS[n.type];
                return (
                  <div
                    key={n.id}
                    className={cn(
                      'group flex gap-3 px-4 py-3 cursor-pointer hover:bg-secondary transition-colors',
                      !n.read && 'bg-primary-subtle/30',
                    )}
                    onClick={() => markRead(n.id)}
                    role="button"
                    tabIndex={0}
                    // Guard: only react when the keydown originated on the row itself,
                    // not from a nested interactive element (e.g. the delete button).
                    // Without this, pressing Space on "X" both deletes the notification
                    // AND marks it read via bubbled keydown.
                    onKeyDown={e => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        markRead(n.id);
                      }
                    }}
                  >
                    <Icon
                      className={cn('h-4 w-4 mt-0.5 shrink-0', ICON_STYLES[n.type])}
                      aria-hidden="true"
                    />
                    <div className="flex-1 min-w-0">
                      <p
                        className={cn(
                          'text-[12px] font-medium text-foreground',
                          !n.read && 'font-semibold',
                        )}
                      >
                        {n.title}
                      </p>
                      {n.body && (
                        <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                          {n.body}
                        </p>
                      )}
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {fmtTime(n.createdAt)}
                      </p>
                    </div>
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        remove(n.id);
                      }}
                      className="shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                      aria-label="Видалити сповіщення"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
