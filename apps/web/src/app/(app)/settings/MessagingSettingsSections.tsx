'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Moon, Send, Unplug } from 'lucide-react';
import type { ApiSchema } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';

type BotStatus = ApiSchema<'TelegramBotStatusDto'>;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Тихі години організації (BR-AUT-013): повідомлення клієнту, що виникло у вікні, чекає до його
 * кінця; однакові межі — без тихих годин. PATCH — лише ці два поля.
 */
export function QuietHoursSection() {
  const { t } = useTranslation('settings');
  const features = useUiFeatures();
  const [saved, setSaved] = useState<{ start: string; end: string } | null>(null);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const ac = new AbortController();
    apiFetch<{ quietHoursStart: string; quietHoursEnd: string }>('/settings/organisation', {
      signal: ac.signal,
    })
      .then(s => {
        setSaved({ start: s.quietHoursStart, end: s.quietHoursEnd });
        setStart(s.quietHoursStart);
        setEnd(s.quietHoursEnd);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : t('common.loadError'));
      });
    return () => ac.abort();
  }, [t]);

  // Порожнє чи недонабране поле (`21:--` у Chrome дає '') — пояснення під полем, а не лише
  // вимкнене «Зберегти» (Bug #1005).
  const startError = HH_MM.test(start) ? undefined : t('quietHours.invalid');
  const endError = HH_MM.test(end) ? undefined : t('quietHours.invalid');
  const invalid = !!startError || !!endError;
  const changed = !!saved && (saved.start !== start || saved.end !== end);

  const save = async () => {
    if (invalid || saving) return;
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch<{ quietHoursStart: string; quietHoursEnd: string }>(
        '/settings/organisation',
        {
          method: 'PATCH',
          body: JSON.stringify({ quietHoursStart: start, quietHoursEnd: end }),
        },
      );
      setSaved({ start: res.quietHoursStart, end: res.quietHoursEnd });
      if (features.toastEnabled) toast.success(t('quietHours.saved'));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.saveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="rounded-xl border border-border bg-surface p-4 space-y-3"
      data-testid="quiet-hours"
    >
      <div className="flex items-center gap-2">
        <Moon className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-foreground">{t('quietHours.title')}</h3>
      </div>
      <p className="text-xs text-muted-foreground">{t('quietHours.hint')}</p>
      {saved && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-32">
            <Input
              id="quiet-hours-start"
              type="time"
              label={t('quietHours.start')}
              value={start}
              onChange={e => setStart(e.target.value)}
              errorMessage={startError}
              className="h-8 text-[13px]"
            />
          </div>
          <div className="w-32">
            <Input
              id="quiet-hours-end"
              type="time"
              label={t('quietHours.end')}
              value={end}
              onChange={e => setEnd(e.target.value)}
              errorMessage={endError}
              className="h-8 text-[13px]"
            />
          </div>
          <Button
            size="sm"
            onClick={() => void save()}
            loading={saving}
            disabled={invalid || !changed}
          >
            {t('common.save')}
          </Button>
        </div>
      )}
      {start && end && start === end && (
        <p className="text-xs text-warning-text">{t('quietHours.off')}</p>
      )}
      {error && (
        <p className="text-xs text-destructive-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * Власний Telegram-бот СТО (BR-AUT-040): «Підключити» перевіряє токен у Telegram (`getMe`), токен
 * назад не віддається. Бот у каналах філій лише вручну (рішення власника 2026-10-30) — після
 * підключення підказка, де його додати.
 */
export function TelegramBotSection({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation('settings');
  const { confirm, dialogProps } = useConfirm();
  const features = useUiFeatures();
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Синхронний замок: два кліки «Підключити» в одному такті — два виклики getMe (ліміт 5 / хв).
  const busyRef = useRef(false);

  useEffect(() => {
    const ac = new AbortController();
    apiFetch<BotStatus>('/settings/telegram-bot', { signal: ac.signal })
      .then(setStatus)
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : t('common.loadError'));
      });
    return () => ac.abort();
  }, [t]);

  const connect = async () => {
    if (!token.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch<BotStatus>('/settings/telegram-bot', {
        method: 'PUT',
        body: JSON.stringify({ token: token.trim() }),
      });
      setStatus(res);
      setToken('');
      if (features.toastEnabled)
        toast.success(t('telegramBot.connected', { name: res.username ?? '' }));
      onChanged();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.saveError'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: t('telegramBot.disconnect'),
      message: t('telegramBot.disconnectConfirm'),
      confirmLabel: t('telegramBot.disconnect'),
      variant: 'destructive',
    });
    if (!ok || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      setStatus(await apiFetch<BotStatus>('/settings/telegram-bot', { method: 'DELETE' }));
      onChanged();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.saveError'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <section
      className="rounded-xl border border-border bg-surface p-4 space-y-3"
      data-testid="telegram-bot"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Send className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-foreground">{t('telegramBot.title')}</h3>
        {status?.connected && (
          <span className="inline-flex items-center gap-1 text-xs text-success-text">
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            {t('telegramBot.statusConnected', { name: status.username ?? '' })}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('telegramBot.hint')}</p>
      {status && !status.connected && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-80 max-w-full">
            <Input
              id="telegram-bot-token"
              type="password"
              label={t('telegramBot.token')}
              placeholder="123456789:AA…"
              autoComplete="off"
              value={token}
              onChange={e => setToken(e.target.value)}
              className="h-8 text-[13px]"
            />
          </div>
          <Button size="sm" onClick={() => void connect()} loading={busy} disabled={!token.trim()}>
            {t('telegramBot.connect')}
          </Button>
        </div>
      )}
      {status?.connected && (
        <>
          <p
            className="text-xs text-info-text bg-info-subtle border border-info-border rounded-lg px-3 py-2"
            role="status"
          >
            {t('telegramBot.addChannelHint')}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void disconnect()}
            loading={busy}
            className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
          >
            <Unplug className="h-3.5 w-3.5" aria-hidden="true" />
            {t('telegramBot.disconnect')}
          </Button>
        </>
      )}
      {error && (
        <p className="text-xs text-destructive-text" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog {...dialogProps} />
    </section>
  );
}
