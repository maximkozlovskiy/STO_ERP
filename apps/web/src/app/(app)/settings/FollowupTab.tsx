'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { type OrgSettings } from './shared';

export default function FollowupTab() {
  const currentFeatures = useUiFeatures();
  const [orgSettings, setOrgSettings] = useState<OrgSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<OrgSettings>('/settings/organisation')
      .then(setOrgSettings)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Помилка завантаження налаштувань'),
      );
  }, []);

  const save = async () => {
    if (!orgSettings) return;
    setSaving(true);
    setError('');
    try {
      const updated = await apiFetch<OrgSettings>('/settings/organisation', {
        method: 'PATCH',
        body: JSON.stringify({
          followUpActive: orgSettings.followUpActive,
          followUpDays: orgSettings.followUpDays,
        }),
      });
      setOrgSettings(updated);
      if (currentFeatures.toastEnabled) toast.success('Збережено');
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : 'Помилка збереження';
      setError(errMsg);
      if (currentFeatures.toastEnabled) toast.error(errMsg);
    } finally {
      setSaving(false);
    }
  };

  if (!orgSettings) return null;

  return (
    <div className="bg-surface rounded-xl border border-border p-6 space-y-4">
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      <div>
        <p className="text-sm text-muted-foreground mb-4">
          Автоматичні SMS нагадування клієнтам після тривалої відсутності та перед технічним
          обслуговуванням.
        </p>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">Включити нагадування</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Система щодня отримуватиме список авто без візитів і надсилатиме SMS
            </p>
          </div>
          <input
            type="checkbox"
            checked={orgSettings.followUpActive ?? false}
            onChange={e => setOrgSettings({ ...orgSettings, followUpActive: e.target.checked })}
            className="h-4 w-4 rounded border-border cursor-pointer"
          />
        </div>
      </div>

      {(orgSettings.followUpActive ?? false) && (
        <div className="mt-4 pt-4 border-t border-border">
          <label className="block text-sm font-medium text-foreground mb-2">
            Нагадувати через (днів без візиту)
          </label>
          <input
            type="number"
            min={30}
            max={365}
            value={orgSettings.followUpDays ?? 90}
            onChange={e =>
              setOrgSettings({
                ...orgSettings,
                followUpDays: Math.max(30, Math.min(365, Number(e.target.value))),
              })
            }
            className="w-32 px-3 py-2 text-sm border border-border rounded-lg bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <p className="text-xs text-muted-foreground mt-1.5">Мінімум 30 днів, максимум 365</p>
        </div>
      )}

      <Button onClick={() => void save()} loading={saving} className="w-full mt-4">
        Зберегти
      </Button>
    </div>
  );
}
