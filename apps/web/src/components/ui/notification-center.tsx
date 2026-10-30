'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { Bell, CheckCheck, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtShortDateTime } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { automationDocumentHref } from '@/lib/automation-href';
import { useEscapeLayer } from '@/hooks/useEscapeLayer';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useMyNotifications,
  useUnreadNotificationsCount,
  type EmployeeNotification,
} from '@/hooks/api/useMyNotifications';
import { Spinner } from './spinner';

interface NotificationCenterProps {
  enabled: boolean;
}

/**
 * Дзвіночок оболонки — серверні сповіщення працівнику (docs/objects/automation.md, BR-AUT-021,
 * US-AUT-3): лічильник непрочитаних опитується раз на 30 с, список читається при відкритті.
 * Клік по сповіщенню позначає його прочитаним і відкриває документ (`?open=` списку); роль без
 * доступу до сторінки документа бачить лише текст. Кожен працівник бачить лише свої — тримає API.
 */
export function NotificationCenter({ enabled }: NotificationCenterProps) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const { employee } = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = enabled && !!employee;

  const unread = useUnreadNotificationsCount(active);
  const list = useMyNotifications(active && open);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const unreadCount = unread.data?.count ?? 0;
  const items = list.data?.items ?? [];

  useEscapeLayer(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!active) return null;

  const activate = (n: EmployeeNotification) => {
    if (!n.readAt) markRead.mutate(n.id);
    const href = automationDocumentHref(n.documentType, n.documentId, employee?.role);
    if (href) {
      setOpen(false);
      router.push(href);
    }
  };

  return (
    <div className="relative" ref={rootRef} data-testid="notification-center">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="relative flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-muted hover:text-white hover:bg-sidebar-hover transition-colors"
        aria-label={
          unreadCount > 0
            ? t('notifications.titleUnread', { n: unreadCount })
            : t('notifications.title')
        }
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 px-0.5 items-center justify-center rounded-full bg-destructive text-white text-[9px] font-bold"
            data-testid="notification-badge"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Ширина — від місця дзвіночка, а не від лівого краю: у меню телефону він на ~92 px (після
          аватара й імені), і «100vw − 5rem» виводило панель за правий край (Bug #1003). */}
      {open && (
        <div
          role="dialog"
          aria-label={t('notifications.title')}
          data-testid="notification-panel"
          className="absolute left-full bottom-0 ml-2 w-80 max-w-[calc(100vw-9rem)] bg-surface border border-border rounded-xl shadow-2xl z-250 overflow-hidden"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <span className="text-[13px] font-semibold text-foreground">
              {t('notifications.title')}
            </span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => markAll.mutate()}
                disabled={markAll.isPending}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
                {t('notifications.markAllRead')}
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto divide-y divide-border">
            {list.isLoading ? (
              <div className="flex justify-center py-8">
                <Spinner size="sm" />
              </div>
            ) : list.isError ? (
              <p className="py-8 text-center text-[13px] text-destructive-text" role="alert">
                {t('notifications.loadError')}
              </p>
            ) : items.length === 0 ? (
              <p className="py-8 text-center text-[13px] text-muted-foreground">
                {t('notifications.empty')}
              </p>
            ) : (
              items.map(n => {
                const href = automationDocumentHref(n.documentType, n.documentId, employee?.role);
                return (
                  <button
                    key={n.id}
                    type="button"
                    data-notification-id={n.id}
                    data-unread={n.readAt ? undefined : 'true'}
                    onClick={() => activate(n)}
                    className={cn(
                      'flex w-full gap-3 px-4 py-3 text-left hover:bg-secondary transition-colors',
                      !n.readAt && 'bg-primary-subtle/30',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                        n.readAt ? 'bg-transparent' : 'bg-primary',
                      )}
                      aria-hidden="true"
                    />
                    <span className="flex-1 min-w-0">
                      <span
                        className={cn(
                          'block text-[12px] text-foreground wrap-break-word',
                          n.readAt ? 'font-medium' : 'font-semibold',
                        )}
                      >
                        {n.title}
                      </span>
                      {n.body && (
                        <span className="block text-[11px] text-muted-foreground mt-0.5 line-clamp-3 wrap-break-word">
                          {n.body}
                        </span>
                      )}
                      <span className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                        {fmtShortDateTime(n.createdAt)}
                        {href && (
                          <>
                            <span aria-hidden="true">·</span>
                            <ExternalLink className="h-3 w-3" aria-hidden="true" />
                            {t('notifications.openDocument')}
                          </>
                        )}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
