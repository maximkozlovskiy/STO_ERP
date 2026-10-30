'use client';

import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { useTranslation } from 'react-i18next';
import { Link2, Send, Unlink } from 'lucide-react';
import '@/i18n/automation-ns';
import { apiFetch } from '@/lib/api-client';
import { fmtDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';
import { Badge } from './badge';
import { Button } from './button';
import { ConfirmDialog } from './confirm-dialog';
import type { TelegramLink } from './TelegramLinkModal';

// QR-бібліотека — лише коли вікно посилання відкрили (бюджет сторінки, check-page-budget.mjs).
const TelegramLinkModal = dynamic(() => import('./TelegramLinkModal'), { ssr: false });

export interface TelegramSubscriptionStatus {
  active: boolean;
  subscribedAt: string | null;
}

interface TelegramSubscriptionBlockProps {
  /** Статус з картки (`telegramSubscription`); `undefined` — ще читається. */
  status: TelegramSubscriptionStatus | undefined;
  /** `POST` — новий одноразовий код (посилання + QR). */
  linkPath: string;
  /** `DELETE` — відписати. */
  unsubscribePath: string;
  /** Чи може поточна роль отримати посилання / відписати (інакше — лише статус). */
  canManage: boolean;
  /** Своя підписка (профіль): «Відписатися» замість «Відписати». */
  self?: boolean;
  /** Після відписки / нового посилання — перечитати статус. */
  onChanged: () => void;
  hint?: string;
}

/**
 * Блок «Telegram-бот» картки контрагента, працівника і профілю (BR-AUT-041): статус підписки,
 * «Отримати посилання» → посилання й QR (код діє 7 днів, одноразовий), «Відписати». Бот не
 * підключено — сервер відповідає 400 з поясненням, його й показуємо.
 */
export function TelegramSubscriptionBlock({
  status,
  linkPath,
  unsubscribePath,
  canManage,
  self = false,
  onChanged,
  hint,
}: TelegramSubscriptionBlockProps) {
  const { t } = useTranslation('automation');
  const { confirm, dialogProps } = useConfirm();
  const [link, setLink] = useState<TelegramLink | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [busy, setBusy] = useState<'link' | 'unsubscribe' | null>(null);
  const [error, setError] = useState('');
  // Синхронний замок: стан `busy` оновлюється лише з наступним рендером, і два кліки в одному
  // такті видали б два коди підписки.
  const busyRef = useRef(false);

  const getLink = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('link');
    setError('');
    try {
      const res = await apiFetch<TelegramLink>(linkPath, { method: 'POST' });
      setLink(res);
      setLinkOpen(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('telegram.botNotConnected'));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const unsubscribe = async () => {
    if (busyRef.current) return;
    const ok = await confirm({
      title: self ? t('telegram.unsubscribeSelf') : t('telegram.unsubscribe'),
      message: t('telegram.unsubscribeConfirm'),
      confirmLabel: self ? t('telegram.unsubscribeSelf') : t('telegram.unsubscribe'),
      variant: 'destructive',
    });
    if (!ok || busyRef.current) return;
    busyRef.current = true;
    setBusy('unsubscribe');
    setError('');
    try {
      await apiFetch<void>(unsubscribePath, { method: 'DELETE' });
      toast.success(t('telegram.unsubscribed'));
      onChanged();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('card.loadError'));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  return (
    <section
      className="rounded-xl border border-border bg-surface p-4 space-y-2"
      data-testid="telegram-subscription"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Send className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-[13px] font-semibold text-foreground">{t('telegram.title')}</h3>
        {status && (
          <Badge
            variant={status.active ? 'success' : 'secondary'}
            dot
            data-testid="telegram-status"
          >
            {status.active
              ? t('telegram.subscribed', { date: fmtDate(status.subscribedAt) })
              : t('telegram.notSubscribed')}
          </Badge>
        )}
      </div>
      {hint && <p className="text-[12px] text-muted-foreground">{hint}</p>}
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void getLink()}
            loading={busy === 'link'}
            disabled={!!busy}
          >
            <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t('telegram.getLink')}
          </Button>
          {status?.active && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void unsubscribe()}
              loading={busy === 'unsubscribe'}
              disabled={!!busy}
              className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
            >
              <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
              {self ? t('telegram.unsubscribeSelf') : t('telegram.unsubscribe')}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p className="text-[12px] text-destructive-text" role="alert">
          {error}
        </p>
      )}
      {/* Chunk вікна вантажиться з першим посиланням; далі вікно живе й закривається з анімацією */}
      {link && (
        <TelegramLinkModal
          open={linkOpen}
          link={link}
          onClose={() => {
            setLinkOpen(false);
            onChanged();
          }}
        />
      )}
      <ConfirmDialog {...dialogProps} />
    </section>
  );
}

interface EmployeeTelegramSubscriptionProps {
  /** `null` — своя підписка (профіль, `/employees/me/*`), інакше — картка працівника для адміна. */
  employeeId: string | null;
  canManage: boolean;
}

/** Підписка працівника на бот: своя — у профілі, чужа — у картці працівника (OWNER / ADMIN). */
export function EmployeeTelegramSubscription({
  employeeId,
  canManage,
}: EmployeeTelegramSubscriptionProps) {
  const { t } = useTranslation('automation');
  const base = employeeId ? `/employees/${employeeId}` : '/employees/me';
  const status = useQuery({
    queryKey: ['employees', 'telegram-subscription', employeeId ?? 'me'],
    queryFn: ({ signal }) =>
      employeeId
        ? apiFetch<{ telegramSubscription?: TelegramSubscriptionStatus }>(base, { signal }).then(
            e => e.telegramSubscription ?? { active: false, subscribedAt: null },
          )
        : apiFetch<TelegramSubscriptionStatus>(`${base}/telegram-subscription`, { signal }),
    staleTime: 0,
  });
  return (
    <TelegramSubscriptionBlock
      status={status.data}
      linkPath={`${base}/telegram-link`}
      unsubscribePath={`${base}/telegram-subscription`}
      canManage={canManage}
      self={!employeeId}
      hint={employeeId ? undefined : t('telegram.selfHint')}
      onChanged={() => void status.refetch()}
    />
  );
}
