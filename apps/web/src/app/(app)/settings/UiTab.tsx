'use client';

import { useEffect, useState } from 'react';
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

const UI_FEATURE_ITEMS: { key: keyof UiFeatures; label: string; description: string }[] = [
  {
    key: 'toastEnabled',
    label: 'Сповіщення (Toast)',
    description: 'Показувати спливаючі повідомлення про результат дій',
  },
  {
    key: 'unsavedGuardEnabled',
    label: 'Захист незбережених змін',
    description: 'Попереджати при закритті форми з незбереженими даними',
  },
  {
    key: 'stockIndicatorEnabled',
    label: 'Індикатор залишку',
    description: 'Показувати доступну кількість при додаванні запчастини',
  },
  {
    key: 'commandPaletteEnabled',
    label: 'Командна палітра',
    description: 'Швидкий пошук та навігація через Ctrl+K',
  },
  {
    key: 'keyboardShortcutsEnabled',
    label: 'Клавіатурні скорочення',
    description: 'Гарячі клавіші для частих дій',
  },
  {
    key: 'savedFiltersEnabled',
    label: 'Збережені фільтри',
    description: 'Зберігати та відновлювати фільтри у списках',
  },
  {
    key: 'inlineEditEnabled',
    label: 'Редагування в рядку',
    description: 'Редагувати поля прямо в таблицях без переходу на форму',
  },
  {
    key: 'syncIndicatorEnabled',
    label: 'Індикатор синхронізації',
    description: 'Показувати статус синхронізації даних',
  },
  {
    key: 'notificationCenterEnabled',
    label: 'Центр сповіщень',
    description: 'Панель з усіма сповіщеннями та подіями',
  },
  {
    key: 'bulkActionsEnabled',
    label: 'Групові дії',
    description: 'Вибір кількох записів для масових операцій',
  },
];

export default function UiTab() {
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
      toast.success('Налаштування інтерфейсу збережено');
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : 'Помилка збереження';
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

      <p className="text-sm text-muted-foreground">
        Вмикайте або вимикайте функції інтерфейсу. Налаштування зберігаються для всієї організації.
      </p>

      {UI_FEATURE_ITEMS.map(({ key, label, description }) => (
        <div
          key={key}
          className="flex items-center justify-between gap-4 py-2 border-b border-border last:border-0"
        >
          <div>
            <p className="text-sm font-medium text-foreground">{label}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
          </div>
          <Toggle
            label=""
            checked={uiFeatures[key]}
            onChange={v => setUiFeatures(f => (f ? { ...f, [key]: v } : f))}
          />
        </div>
      ))}

      <Button onClick={() => void saveUiFeatures()} loading={saving} className="w-full mt-2">
        Зберегти
      </Button>
    </div>
  );
}
