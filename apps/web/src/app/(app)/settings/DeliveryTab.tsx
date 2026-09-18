'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import ProviderRegistryPanel, { type PanelProviderMeta } from './ProviderRegistryPanel';

interface OrgSettings {
  deliveryPollIntervalMinutes?: number;
}

/**
 * Вкладка доставки: активна служба доставки per-branch (реєстр) + інтервал опитування статусу
 * (хв, org-рівень). Щойно у документі купівлі вказано номер накладної — статус оновлюється
 * автоматично з цим інтервалом.
 */
export default function DeliveryTab() {
  const { t } = useTranslation('settings');
  const currentFeatures = useUiFeatures();
  const [interval, setInterval] = useState('30');
  const [savingInterval, setSavingInterval] = useState(false);
  const [error, setError] = useState('');

  // Схема полів кредів служб доставки (бекенд list() дає лише code/name). Назва — бренд.
  const deliveryProviders: PanelProviderMeta[] = useMemo(
    () => [
      {
        code: 'novaposhta',
        name: 'Нова Пошта',
        fields: [{ key: 'apiKey', label: t('delivery.novaposhtaApiKey'), secret: true }],
      },
    ],
    [t],
  );

  useEffect(() => {
    apiFetch<OrgSettings>('/settings/organisation')
      .then(s => {
        if (typeof s.deliveryPollIntervalMinutes === 'number') {
          setInterval(String(s.deliveryPollIntervalMinutes));
        }
      })
      .catch((e: unknown) =>
        console.warn('[DeliveryTab] settings load failed:', e instanceof Error ? e.message : e),
      );
  }, []);

  const saveInterval = async () => {
    const n = Number(interval);
    if (!Number.isFinite(n) || n < 5 || n > 1440) {
      setError(t('delivery.intervalError'));
      return;
    }
    setSavingInterval(true);
    setError('');
    try {
      await apiFetch('/settings/organisation', {
        method: 'PATCH',
        body: JSON.stringify({ deliveryPollIntervalMinutes: n }),
      });
      if (currentFeatures.toastEnabled) toast.success(t('delivery.intervalSaved'));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('common.saveError');
      setError(msg);
      if (currentFeatures.toastEnabled) toast.error(msg);
    } finally {
      setSavingInterval(false);
    }
  };

  return (
    <div className="space-y-8 max-w-2xl">
      <ProviderRegistryPanel
        title={t('delivery.serviceTitle')}
        endpoint="delivery-providers"
        providers={deliveryProviders}
      />

      <div className="border-t border-border pt-6 space-y-3">
        <h3 className="text-sm font-semibold text-foreground">{t('delivery.pollTitle')}</h3>
        <p className="text-xs text-muted-foreground">{t('delivery.pollDescription')}</p>
        {error && (
          <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
            {error}
          </div>
        )}
        <div className="flex items-end gap-3">
          <div className="w-40">
            <Input
              label={t('delivery.intervalLabel')}
              type="number"
              min={5}
              max={1440}
              value={interval}
              onChange={e => setInterval(e.target.value)}
            />
          </div>
          <Button onClick={() => void saveInterval()} loading={savingInterval}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
