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
  bankStatementPollIntervalMinutes?: number;
}

/**
 * Вкладка банк-виписки: активний банк-провайдер per-branch (Privat24 Merchant) + інтервал
 * auto-pull виписки (хв, org-рівень) + кнопка «Підтягнути зараз» (ставить job у чергу).
 */
export default function BankStatementsTab() {
  const { t } = useTranslation('settings');
  const currentFeatures = useUiFeatures();
  const [interval, setInterval] = useState('60');
  const [savingInterval, setSavingInterval] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState('');

  // Схема полів кредів Privat24 (бекенд list() дає лише code/name).
  const bankProviders: PanelProviderMeta[] = useMemo(
    () => [
      {
        code: 'privat24',
        name: 'Приват24',
        fields: [
          { key: 'merchantId', label: t('bankStatements.merchantId') },
          { key: 'token', label: t('bankStatements.token'), secret: true },
        ],
      },
    ],
    [t],
  );

  useEffect(() => {
    apiFetch<OrgSettings>('/settings/organisation')
      .then(s => {
        if (typeof s.bankStatementPollIntervalMinutes === 'number') {
          setInterval(String(s.bankStatementPollIntervalMinutes));
        }
      })
      .catch((e: unknown) =>
        console.warn(
          '[BankStatementsTab] settings load failed:',
          e instanceof Error ? e.message : e,
        ),
      );
  }, []);

  const saveInterval = async () => {
    const n = Number(interval);
    if (!Number.isFinite(n) || n < 15 || n > 1440) {
      setError(t('bankStatements.intervalError'));
      return;
    }
    setSavingInterval(true);
    setError('');
    try {
      await apiFetch('/settings/organisation', {
        method: 'PATCH',
        body: JSON.stringify({ bankStatementPollIntervalMinutes: n }),
      });
      if (currentFeatures.toastEnabled) toast.success(t('bankStatements.intervalSaved'));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('common.saveError');
      setError(msg);
      if (currentFeatures.toastEnabled) toast.error(msg);
    } finally {
      setSavingInterval(false);
    }
  };

  const pullNow = async () => {
    setPulling(true);
    setError('');
    try {
      await apiFetch('/bank-statement-providers/pull-now', { method: 'POST' });
      if (currentFeatures.toastEnabled) toast.success(t('bankStatements.pullQueued'));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('bankStatements.pullError');
      setError(msg);
      if (currentFeatures.toastEnabled) toast.error(msg);
    } finally {
      setPulling(false);
    }
  };

  return (
    <div className="space-y-8 max-w-2xl">
      <ProviderRegistryPanel
        title={t('bankStatements.serviceTitle')}
        endpoint="bank-statement-providers"
        providers={bankProviders}
      />

      <div className="border-t border-border pt-6 space-y-3">
        <h3 className="text-sm font-semibold text-foreground">{t('bankStatements.pollTitle')}</h3>
        <p className="text-xs text-muted-foreground">{t('bankStatements.pollDescription')}</p>
        {error && (
          <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
            {error}
          </div>
        )}
        <div className="flex items-end gap-3 flex-wrap">
          <div className="w-40">
            <Input
              label={t('bankStatements.intervalLabel')}
              type="number"
              min={15}
              max={1440}
              value={interval}
              onChange={e => setInterval(e.target.value)}
            />
          </div>
          <Button onClick={() => void saveInterval()} loading={savingInterval}>
            {t('common.save')}
          </Button>
          <Button variant="outline" onClick={() => void pullNow()} loading={pulling}>
            {t('bankStatements.pullNow')}
          </Button>
        </div>
      </div>
    </div>
  );
}
