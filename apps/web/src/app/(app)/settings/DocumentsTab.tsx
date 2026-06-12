'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { type OrgSettings } from './shared';

export default function DocumentsTab() {
  const features = useUiFeatures();
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
          recalcPlannedHoursFromLines: orgSettings.recalcPlannedHoursFromLines ?? false,
        }),
      });
      setOrgSettings(updated);
      if (features.toastEnabled) toast.success('Збережено');
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : 'Помилка збереження';
      setError(errMsg);
      if (features.toastEnabled) toast.error(errMsg);
    } finally {
      setSaving(false);
    }
  };

  if (!orgSettings) return null;

  return (
    <div className="bg-surface rounded-xl border border-border p-6 space-y-6">
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      {/* Наряди */}
      <section>
        <h2 className="text-sm font-semibold text-foreground mb-4">Наряди</h2>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">
              Перераховувати планові нормогодини по роботах
            </p>
            <p className="text-xs text-muted-foreground mt-1 max-w-md">
              Якщо увімкнено — при додаванні або видаленні рядків робіт поле «Планові нормогодини»
              автоматично збільшується до суми нормогодин по рядках. Якщо вручну встановлено більше
              значення — воно не зменшується автоматично.
            </p>
          </div>
          <label
            className="relative flex-shrink-0 mt-0.5 cursor-pointer"
            title="Якщо увімкнено, при додаванні або видаленні робіт поле «Планові нормогодини» автоматично збільшується до суми нормогодин по рядках. Зменшення вручну — дозволено."
          >
            <input
              type="checkbox"
              checked={orgSettings.recalcPlannedHoursFromLines ?? false}
              onChange={e =>
                setOrgSettings({ ...orgSettings, recalcPlannedHoursFromLines: e.target.checked })
              }
              className="h-4 w-4 rounded border-border cursor-pointer"
            />
          </label>
        </div>
      </section>

      <div className="pt-2">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? 'Збереження...' : 'Зберегти'}
        </Button>
      </div>
    </div>
  );
}
