'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { type OrgSettings } from './shared';

/**
 * Налаштування програми лояльності (OrganisationSettings). Читає/патчить `/settings/organisation`
 * напряму (патерн FollowupTab — окремого хука для org-settings немає). Патчить ЛИШЕ 4 loyalty-поля.
 *
 * Семантика (з loyalty.service earn/redeem):
 *  - loyaltyEarnPer    — за кожні N грн оплати нараховується батч балів;
 *  - loyaltyEarnPoints — скільки балів за той батч (100грн + 1 → 1 бал за кожні 100 грн);
 *  - loyaltyRedeemRate — 1 бал = N грн знижки при списанні;
 *  - loyaltyEnabled    — вимикач НАРАХУВАННЯ (списання балів працює завжди).
 */
export default function LoyaltyTab() {
  const { t } = useTranslation('settings');
  const currentFeatures = useUiFeatures();
  const [orgSettings, setOrgSettings] = useState<OrgSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<OrgSettings>('/settings/organisation')
      .then(setOrgSettings)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : t('common.loadError')));
  }, [t]);

  const save = async () => {
    if (!orgSettings) return;
    setSaving(true);
    setError('');
    try {
      const updated = await apiFetch<OrgSettings>('/settings/organisation', {
        method: 'PATCH',
        body: JSON.stringify({
          loyaltyEnabled: orgSettings.loyaltyEnabled,
          loyaltyEarnPer: orgSettings.loyaltyEarnPer,
          loyaltyEarnPoints: orgSettings.loyaltyEarnPoints,
          loyaltyRedeemRate: orgSettings.loyaltyRedeemRate,
        }),
      });
      setOrgSettings(updated);
      if (currentFeatures.toastEnabled) toast.success(t('common.saved'));
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : t('common.saveError');
      setError(errMsg);
      if (currentFeatures.toastEnabled) toast.error(errMsg);
    } finally {
      setSaving(false);
    }
  };

  if (!orgSettings) return null;

  const enabled = orgSettings.loyaltyEnabled ?? false;
  const earnPer = orgSettings.loyaltyEarnPer ?? 100;
  const earnPoints = orgSettings.loyaltyEarnPoints ?? 1;
  const redeemRate = orgSettings.loyaltyRedeemRate ?? 1;

  return (
    <div className="bg-surface rounded-xl border border-border p-6 space-y-4">
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      <div>
        <p className="text-sm text-muted-foreground mb-4">{t('loyalty.intro')}</p>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">{t('loyalty.enableTitle')}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{t('loyalty.enableDescription')}</p>
          </div>
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => setOrgSettings({ ...orgSettings, loyaltyEnabled: e.target.checked })}
            className="h-4 w-4 rounded border-border cursor-pointer"
          />
        </div>
      </div>

      {enabled && (
        <div className="mt-4 pt-4 border-t border-border space-y-4">
          {/* earnPer + earnPoints — правило нарахування */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                {t('loyalty.earnPer')}
              </label>
              <input
                type="number"
                min={1}
                step={1}
                value={earnPer}
                onChange={e =>
                  setOrgSettings({
                    ...orgSettings,
                    loyaltyEarnPer: Math.max(1, Number(e.target.value) || 1),
                  })
                }
                className="w-32 px-3 py-2 text-sm border border-border rounded-lg bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                {t('loyalty.earnPoints')}
              </label>
              <input
                type="number"
                min={0}
                step={1}
                value={earnPoints}
                onChange={e =>
                  setOrgSettings({
                    ...orgSettings,
                    loyaltyEarnPoints: Math.max(0, Number(e.target.value) || 0),
                  })
                }
                className="w-32 px-3 py-2 text-sm border border-border rounded-lg bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            {t('loyalty.earnExample', { earnPer, earnPoints })}
          </p>

          {/* redeemRate — курс списання */}
          <div className="pt-2 border-t border-border">
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('loyalty.redeemRate')}
            </label>
            <input
              type="number"
              min={0}
              step={0.01}
              value={redeemRate}
              onChange={e =>
                setOrgSettings({
                  ...orgSettings,
                  loyaltyRedeemRate: Math.max(0, Number(e.target.value) || 0),
                })
              }
              className="w-32 px-3 py-2 text-sm border border-border rounded-lg bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <p className="text-xs text-muted-foreground mt-1.5">
              {t('loyalty.redeemExample', { redeemRate })}
            </p>
          </div>
        </div>
      )}

      <Button onClick={() => void save()} loading={saving} className="w-full mt-4">
        {t('common.save')}
      </Button>
    </div>
  );
}
