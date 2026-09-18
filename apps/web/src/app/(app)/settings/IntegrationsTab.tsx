'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '@/hooks/useConfirm';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { fmtShortDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { type WebhookEndpoint, type WebhookDelivery, WEBHOOK_EVENT_VALUES } from './shared';

export default function IntegrationsTab() {
  const { t } = useTranslation('settings');
  const { confirm, dialogProps } = useConfirm();
  const currentFeatures = useUiFeatures();
  const eventLabel = (value: string): string =>
    WEBHOOK_EVENT_VALUES.includes(value) ? t(`integrations.eventOptions.${value}`) : value;
  const [webhooks, setWebhooks] = useState<WebhookEndpoint[]>([]);
  const [webhookForm, setWebhookForm] = useState({ url: '', secret: '', events: [] as string[] });
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [webhookDeliveries, setWebhookDeliveries] = useState<{ [id: string]: WebhookDelivery[] }>(
    {},
  );
  const [loadingDeliveries, setLoadingDeliveries] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<{ items: WebhookEndpoint[] }>('/webhooks')
      .then(d => setWebhooks(d.items))
      .catch((e: unknown) =>
        console.warn('[IntegrationsTab] /webhooks failed:', e instanceof Error ? e.message : e),
      );
  }, []);

  const addWebhook = async () => {
    if (!webhookForm.url || webhookForm.events.length === 0) {
      setError(t('integrations.urlEventRequired'));
      return;
    }
    setSavingWebhook(true);
    try {
      const created = await apiFetch<WebhookEndpoint>('/webhooks', {
        method: 'POST',
        body: JSON.stringify({
          url: webhookForm.url,
          secret: webhookForm.secret || undefined,
          events: webhookForm.events,
        }),
      });
      setWebhooks(prev => [created, ...prev]);
      setWebhookForm({ url: '', secret: '', events: [] });
      if (currentFeatures.toastEnabled) toast.success(t('integrations.webhookAdded'));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setSavingWebhook(false);
    }
  };

  const toggleWebhook = async (wh: WebhookEndpoint) => {
    try {
      const updated = await apiFetch<WebhookEndpoint>(`/webhooks/${wh.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !wh.isActive }),
      });
      setWebhooks(prev => prev.map(w => (w.id === updated.id ? updated : w)));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.error'));
    }
  };

  const deleteWebhook = async (id: string) => {
    if (!(await confirm({ title: t('integrations.deleteConfirm'), variant: 'destructive' })))
      return;
    try {
      await apiFetch(`/webhooks/${id}`, { method: 'DELETE' });
      setWebhooks(prev => prev.filter(w => w.id !== id));
      if (currentFeatures.toastEnabled) toast.success(t('integrations.webhookDeleted'));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.error'));
    }
  };

  const loadDeliveries = async (endpointId: string) => {
    if (webhookDeliveries[endpointId]) {
      setWebhookDeliveries(prev => {
        const next = { ...prev };
        delete next[endpointId];
        return next;
      });
      return;
    }
    setLoadingDeliveries(endpointId);
    try {
      const d = await apiFetch<{ items: WebhookDelivery[] }>(`/webhooks/${endpointId}/deliveries`);
      setWebhookDeliveries(prev => ({ ...prev, [endpointId]: d.items }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setLoadingDeliveries(null);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      {/* Add webhook form */}
      <div className="bg-surface rounded-xl border border-border p-5 space-y-3">
        <h2 className="font-semibold text-foreground">{t('integrations.addWebhook')}</h2>
        <Input
          label={t('integrations.url')}
          type="url"
          value={webhookForm.url}
          onChange={e => setWebhookForm(f => ({ ...f, url: e.target.value }))}
          placeholder={t('integrations.urlPlaceholder')}
          className="h-8 text-[13px]"
        />
        <Input
          label={t('integrations.secret')}
          type="text"
          value={webhookForm.secret}
          onChange={e => setWebhookForm(f => ({ ...f, secret: e.target.value }))}
          placeholder={t('integrations.secretPlaceholder')}
          className="h-8 text-[13px]"
        />
        <div>
          <label className="block text-[13px] font-medium text-foreground mb-2">
            {t('integrations.events')}
          </label>
          <div className="space-y-1.5">
            {WEBHOOK_EVENT_VALUES.map(value => (
              <label key={value} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={webhookForm.events.includes(value)}
                  onChange={e => {
                    const events = e.target.checked
                      ? [...webhookForm.events, value]
                      : webhookForm.events.filter(v => v !== value);
                    setWebhookForm(f => ({ ...f, events }));
                  }}
                  className="rounded border-border"
                />
                <span className="text-[13px] text-foreground">{eventLabel(value)}</span>
              </label>
            ))}
          </div>
        </div>
        <Button onClick={() => void addWebhook()} loading={savingWebhook}>
          {t('integrations.addWebhook')}
        </Button>
      </div>

      {/* Webhooks list */}
      <div className="bg-surface rounded-xl border border-border divide-y divide-border">
        {webhooks.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">{t('integrations.noWebhooks')}</p>
        )}
        {webhooks.map(wh => (
          <div key={wh.id}>
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{wh.url}</p>
                <p className="text-xs text-muted-foreground">
                  {wh.events.map(e => eventLabel(e)).join(', ')}
                </p>
              </div>
              <div className="flex items-center gap-2 ml-3 shrink-0">
                <button
                  onClick={() => void loadDeliveries(wh.id)}
                  disabled={loadingDeliveries === wh.id}
                  className="text-xs text-primary hover:underline px-1"
                >
                  {webhookDeliveries[wh.id] ? t('integrations.hideLog') : t('integrations.log')}
                </button>
                <button
                  onClick={() => void toggleWebhook(wh)}
                  className={cn(
                    'relative inline-flex h-5 w-9 rounded-full transition-colors',
                    wh.isActive ? 'bg-primary' : 'bg-border',
                  )}
                  title={wh.isActive ? t('integrations.active') : t('integrations.inactive')}
                >
                  <span
                    className={cn(
                      'inline-block h-4 w-4 rounded-full bg-surface shadow transform transition-transform mt-0.5',
                      wh.isActive ? 'translate-x-4' : 'translate-x-0.5',
                    )}
                  />
                </button>
                <button
                  onClick={() => void deleteWebhook(wh.id)}
                  className="text-xs text-destructive/60 hover:text-destructive px-1"
                >
                  ×
                </button>
              </div>
            </div>
            {webhookDeliveries[wh.id] && (
              <div className="px-4 pb-3">
                <div className="bg-secondary rounded-lg overflow-hidden divide-y divide-border border border-border">
                  {webhookDeliveries[wh.id].length === 0 && (
                    <p className="px-3 py-2 text-xs text-muted-foreground">
                      {t('integrations.noDeliveries')}
                    </p>
                  )}
                  {webhookDeliveries[wh.id].map(d => (
                    <div key={d.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                      <span
                        className={cn(
                          'w-2 h-2 rounded-full shrink-0',
                          d.status === 'DELIVERED' ? 'bg-success' : 'bg-destructive',
                        )}
                      />
                      <span className="font-mono text-muted-foreground">{eventLabel(d.event)}</span>
                      <span
                        className={cn(
                          'px-1.5 py-0.5 rounded text-[11px]',
                          d.status === 'DELIVERED'
                            ? 'bg-success-subtle text-success'
                            : 'bg-destructive-subtle text-destructive-text',
                        )}
                      >
                        {d.status === 'DELIVERED'
                          ? t('integrations.delivered')
                          : t('integrations.deliveryError')}
                      </span>
                      {d.responseCode != null && (
                        <span className="text-muted-foreground">HTTP {d.responseCode}</span>
                      )}
                      <span className="text-muted-foreground ml-auto">
                        {fmtShortDateTime(d.createdAt)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
