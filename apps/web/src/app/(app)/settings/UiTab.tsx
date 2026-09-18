'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures, invalidateUiFeaturesCache, type UiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-foreground">{label}</span>
      <button
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-border',
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 rounded-full bg-surface shadow transform transition-transform mt-0.5',
            checked ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}

// Ключі фіч у порядку відображення; підписи/описи — у settings-каталозі (ui.features.<key>.*).
const UI_FEATURE_KEYS: (keyof UiFeatures)[] = [
  'toastEnabled',
  'unsavedGuardEnabled',
  'stockIndicatorEnabled',
  'commandPaletteEnabled',
  'keyboardShortcutsEnabled',
  'savedFiltersEnabled',
  'inlineEditEnabled',
  'syncIndicatorEnabled',
  'notificationCenterEnabled',
  'bulkActionsEnabled',
];

export default function UiTab() {
  const { t } = useTranslation('settings');
  const currentFeatures = useUiFeatures();
  const [uiFeatures, setUiFeatures] = useState<UiFeatures | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setUiFeatures(currentFeatures);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveUiFeatures = async () => {
    if (!uiFeatures) return;
    setSaving(true);
    setError('');
    try {
      await apiFetch('/settings/organisation', {
        method: 'PATCH',
        body: JSON.stringify({ uiFeatures }),
      });
      invalidateUiFeaturesCache();
      window.dispatchEvent(new CustomEvent('sto:ui-features-change'));
      toast.success(t('ui.saved'));
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : t('common.saveError');
      setError(errMsg);
      toast.error(errMsg);
    } finally {
      setSaving(false);
    }
  };

  if (!uiFeatures) return null;

  return (
    <div className="bg-surface rounded-xl border border-border p-6 space-y-4">
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      <p className="text-sm text-muted-foreground">{t('ui.intro')}</p>

      {UI_FEATURE_KEYS.map(key => (
        <div
          key={key}
          className="flex items-center justify-between gap-4 py-2 border-b border-border last:border-0"
        >
          <div>
            <p className="text-sm font-medium text-foreground">{t(`ui.features.${key}.label`)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t(`ui.features.${key}.description`)}
            </p>
          </div>
          <Toggle
            label=""
            checked={uiFeatures[key]}
            onChange={v => setUiFeatures(f => (f ? { ...f, [key]: v } : f))}
          />
        </div>
      ))}

      <Button onClick={() => void saveUiFeatures()} loading={saving} className="w-full mt-2">
        {t('common.save')}
      </Button>
    </div>
  );
}
