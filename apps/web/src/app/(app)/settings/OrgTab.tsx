'use client';

import { useEffect, useState } from 'react';
import { useConfirm } from '@/hooks/useConfirm';
import { apiFetch } from '@/lib/api-client';
import { applyTheme } from '@/lib/theme';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import { type OrgSettings, type CostMethod, COST_METHOD_OPTIONS, VAT_LABELS } from './shared';

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <div>
      <label className="block text-[13px] font-medium text-foreground mb-1">{label}</label>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={e => onChange(Number(e.target.value))}
        className="w-32 h-8 text-[13px]"
      />
    </div>
  );
}

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

interface Currency {
  id: string;
  code: string;
  name: string;
  symbol: string | null;
}

export default function OrgTab() {
  const { confirm, dialogProps } = useConfirm();
  const currentFeatures = useUiFeatures();
  const [orgSettings, setOrgSettings] = useState<OrgSettings | null>(null);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    // Bug review: /currencies повертає { items, total }, не bare array →
    // setCurrencies(c) присвоював об'єкт; currencies.length було undefined →
    // <Select> ніколи не рендерився, тільки text-input fallback.
    // Plus: allSettled — фейл /currencies не повинен валити завантаження settings.
    let cancelled = false;
    void Promise.allSettled([
      apiFetch<OrgSettings>('/settings/organisation'),
      apiFetch<{ items: Currency[]; total: number }>('/currencies'),
    ]).then(([settingsRes, currRes]) => {
      if (cancelled) return;
      if (settingsRes.status === 'fulfilled') {
        setOrgSettings(settingsRes.value);
        applyTheme(settingsRes.value.brandTheme);
      } else {
        const e = settingsRes.reason;
        setError(e instanceof Error ? e.message : 'Помилка завантаження налаштувань');
      }
      if (currRes.status === 'fulfilled') {
        setCurrencies(currRes.value.items ?? []);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveOrgSettings = async () => {
    if (!orgSettings) return;
    setSaving(true);
    setMsg('');
    setError('');
    try {
      const updated = await apiFetch<OrgSettings>('/settings/organisation', {
        method: 'PATCH',
        body: JSON.stringify({
          currency: orgSettings.currency,
          vatMode: orgSettings.vatMode,
          invoiceDueDays: orgSettings.invoiceDueDays,
          autoArchiveDays: orgSettings.autoArchiveDays,
          defaultWarrantyDays: orgSettings.defaultWarrantyDays,
          requireClientApproval: orgSettings.requireClientApproval,
          allowPartialPayment: orgSettings.allowPartialPayment,
          brandTheme: orgSettings.brandTheme,
          costMethod: orgSettings.costMethod,
        }),
      });
      applyTheme(updated.brandTheme);
      setOrgSettings(updated);
      setMsg('Збережено');
      if (currentFeatures.toastEnabled) toast.success('Налаштування збережено');
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
    <>
      {msg && (
        <div className="mb-4 text-sm text-success bg-success-subtle border border-success/20 rounded-lg p-3">
          {msg}
        </div>
      )}
      {error && (
        <div className="mb-4 text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}
      <div className="bg-surface rounded-xl border border-border p-6 space-y-5">
        <div>
          <label className="block text-[13px] font-medium text-foreground mb-1">
            Валюта обліку
          </label>
          {currencies.length > 0 ? (
            <Select
              value={orgSettings.currency}
              onChange={e => setOrgSettings({ ...orgSettings, currency: e.target.value })}
              className="w-auto h-8 text-[13px] py-0.5 px-2 pr-7"
            >
              {currencies.map(c => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              value={orgSettings.currency}
              onChange={e =>
                setOrgSettings({
                  ...orgSettings,
                  // Bug #362: ISO коди UPPERCASE у БД (UAH/USD/EUR). Без normalize
                  // `uah` → 400 з backend (case-sensitive lookup). Cap at 10 — VarChar(10).
                  currency: e.target.value.toUpperCase().slice(0, 10),
                })
              }
              className="w-32 h-8 text-[13px]"
              placeholder="UAH"
              maxLength={10}
            />
          )}
          <p className="text-xs text-muted-foreground mt-1">
            Використовується за замовчуванням у договорах і звітах
          </p>
        </div>

        <div>
          <label className="block text-[13px] font-medium text-foreground mb-1">Режим ПДВ</label>
          <Select
            value={orgSettings.vatMode}
            onChange={e => setOrgSettings({ ...orgSettings, vatMode: e.target.value })}
            className="w-auto h-8 text-[13px] py-0.5 px-2 pr-7"
          >
            {Object.entries(VAT_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </div>

        <NumberField
          label="Термін оплати рахунку (днів)"
          value={orgSettings.invoiceDueDays}
          onChange={v => setOrgSettings({ ...orgSettings, invoiceDueDays: v })}
          min={1}
          max={365}
        />
        <NumberField
          label="Авто-архівування (днів після закриття)"
          value={orgSettings.autoArchiveDays}
          onChange={v => setOrgSettings({ ...orgSettings, autoArchiveDays: v })}
          min={1}
          max={365}
        />
        <NumberField
          label="Гарантійний термін за замовчуванням (днів)"
          value={orgSettings.defaultWarrantyDays}
          onChange={v => setOrgSettings({ ...orgSettings, defaultWarrantyDays: v })}
          min={0}
          max={3650}
        />

        <div className="space-y-3">
          <Toggle
            label="Вимагати підтвердження клієнта"
            checked={orgSettings.requireClientApproval}
            onChange={v => setOrgSettings({ ...orgSettings, requireClientApproval: v })}
          />
          <Toggle
            label="Дозволити часткову оплату"
            checked={orgSettings.allowPartialPayment}
            onChange={v => setOrgSettings({ ...orgSettings, allowPartialPayment: v })}
          />
        </div>

        <div role="radiogroup" aria-label="Метод списання партій">
          <label className="block text-[13px] font-medium text-foreground mb-1">
            Метод списання партій
          </label>
          <p className="text-xs text-muted-foreground mb-2">
            Визначає порядок списання запчастин з партійного обліку при виконанні нарядів
          </p>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {COST_METHOD_OPTIONS.map(({ value, label, hint }) => {
              const selected = orgSettings.costMethod === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={async () => {
                    if (selected) return;
                    const ok = await confirm({
                      title: 'Змінити метод списання партій?',
                      message: `Зміна з ${COST_METHOD_OPTIONS.find(o => o.value === orgSettings.costMethod)?.label ?? orgSettings.costMethod} на ${label} вплине на всі майбутні списання запчастин у нарядах. Поточні залишки та вже закриті наряди не змінюються, але собівартість нових нарядів буде розраховуватись за новим методом. Переконайтеся, що ви розумієте наслідки для фінансової звітності.`,
                      confirmLabel: `Так, змінити на ${label}`,
                      variant: 'destructive',
                    });
                    if (!ok) return;
                    setOrgSettings({ ...orgSettings, costMethod: value as CostMethod });
                  }}
                  className={cn(
                    'flex-1 min-w-40 px-3 py-2.5 rounded-lg border text-sm font-medium transition-colors text-left',
                    selected
                      ? 'border-primary bg-primary-subtle text-primary'
                      : 'border-border bg-surface text-muted-foreground hover:border-primary/40 hover:text-foreground',
                  )}
                >
                  <div className="font-semibold">{label}</div>
                  <div className="text-xs mt-0.5 opacity-70">{hint}</div>
                </button>
              );
            })}
          </div>
        </div>

        <Button onClick={() => void saveOrgSettings()} loading={saving} className="w-full">
          Зберегти
        </Button>
      </div>
      <ConfirmDialog {...dialogProps} />
    </>
  );
}
