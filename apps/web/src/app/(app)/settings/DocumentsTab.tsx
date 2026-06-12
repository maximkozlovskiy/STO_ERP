'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { type OrgSettings } from './shared';

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-5 w-9 rounded-full transition-colors shrink-0',
        checked ? 'bg-primary' : 'bg-border',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 rounded-full bg-surface shadow transform transition-transform mt-0.5',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

export default function DocumentsTab() {
  const features = useUiFeatures();
  const [orgSettings, setOrgSettings] = useState<OrgSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Snapshot of loaded values — used to PATCH only changed fields (§26 sto-dev:
  // "PATCH тільки змінені поля, не весь об'єкт"). Without this, saving with no
  // toggle change still sends both flags, masking server-side merge bugs.
  const initialRef = useRef<{
    recalcPlannedHoursFromLines: boolean;
    syncCalendarSlotWithPlannedHours: boolean;
  } | null>(null);

  useEffect(() => {
    apiFetch<OrgSettings>('/settings/organisation')
      .then(s => {
        setOrgSettings(s);
        initialRef.current = {
          recalcPlannedHoursFromLines: s.recalcPlannedHoursFromLines ?? true,
          syncCalendarSlotWithPlannedHours: s.syncCalendarSlotWithPlannedHours ?? true,
        };
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Помилка завантаження налаштувань'),
      );
  }, []);

  const save = async () => {
    if (!orgSettings) return;
    setSaving(true);
    setError('');
    try {
      const initial = initialRef.current;
      const recalcNow = orgSettings.recalcPlannedHoursFromLines ?? true;
      const syncNow = orgSettings.syncCalendarSlotWithPlannedHours ?? true;
      const patch: {
        recalcPlannedHoursFromLines?: boolean;
        syncCalendarSlotWithPlannedHours?: boolean;
      } = {};
      if (!initial || initial.recalcPlannedHoursFromLines !== recalcNow) {
        patch.recalcPlannedHoursFromLines = recalcNow;
      }
      if (!initial || initial.syncCalendarSlotWithPlannedHours !== syncNow) {
        patch.syncCalendarSlotWithPlannedHours = syncNow;
      }
      // Nothing actually changed — short-circuit без RTT і без зайвого toast.
      if (Object.keys(patch).length === 0) {
        if (features.toastEnabled) toast.info('Змін немає');
        return;
      }
      const updated = await apiFetch<OrgSettings>('/settings/organisation', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setOrgSettings(updated);
      initialRef.current = {
        recalcPlannedHoursFromLines: updated.recalcPlannedHoursFromLines ?? true,
        syncCalendarSlotWithPlannedHours: updated.syncCalendarSlotWithPlannedHours ?? true,
      };
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

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Наряди</h2>

        <div
          className="flex items-center justify-between gap-4 py-2 border-b border-border"
          title="Якщо увімкнено, при додаванні або видаленні робіт поле «Планові нормогодини» автоматично збільшується до суми нормогодин по рядках. Зменшення вручну — дозволено."
        >
          <div>
            <p className="text-sm font-medium text-foreground">
              Перераховувати планові нормогодини по роботах
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              При додаванні або видаленні рядків робіт поле «Планові нормогодини» автоматично
              збільшується до суми нормогодин по рядках. Якщо вручну встановлено більше значення —
              воно не зменшується автоматично.
            </p>
          </div>
          <Toggle
            checked={orgSettings.recalcPlannedHoursFromLines ?? true}
            onChange={v => setOrgSettings({ ...orgSettings, recalcPlannedHoursFromLines: v })}
          />
        </div>

        <div
          className="flex items-center justify-between gap-4 py-2 border-b border-border"
          title="Якщо увімкнено, при збереженні наряду перевіряє чи планові дати збігаються зі слотами в календарі та пропонує синхронізувати."
        >
          <div>
            <p className="text-sm font-medium text-foreground">
              Синхронізувати слот календаря при зміні планових годин наряду
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              При збереженні наряду, якщо планові дати відрізняються від слоту в календарі — система
              запропонує синхронізувати слот.
            </p>
          </div>
          <Toggle
            checked={orgSettings.syncCalendarSlotWithPlannedHours ?? true}
            onChange={v => setOrgSettings({ ...orgSettings, syncCalendarSlotWithPlannedHours: v })}
          />
        </div>
      </section>

      <div>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? 'Збереження...' : 'Зберегти'}
        </Button>
      </div>
    </div>
  );
}
