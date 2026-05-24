'use client';

import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { THEMES, type ThemeName, applyTheme } from '@/lib/theme';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface OrgSettings {
  orgId: string;
  currency: string;
  vatMode: string;
  invoiceDueDays: number;
  autoArchiveDays: number;
  defaultWarrantyDays: number;
  requireClientApproval: boolean;
  allowPartialPayment: boolean;
  brandTheme: string;
  updatedAt: string;
}

interface PaymentMethod {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
  requiresFiscal: boolean;
}

interface NotificationTemplate {
  id: string; eventType: string; channel: string;
  subject: string | null; body: string; isActive: boolean;
}

const EVENT_LABELS: Record<string, string> = {
  WO_COMPLETED: 'Наряд завершено', WO_ESTIMATE_READY: 'Кошторис готовий',
  WO_APPROVED: 'Наряд підтверджено', WO_IN_PROGRESS: 'Наряд в роботі',
  WO_READY_FOR_PICKUP: 'Авто готове до видачі', PAYMENT_RECEIVED: 'Оплата отримана',
  INVOICE_SENT: 'Рахунок надіслано', LOW_STOCK_ALERT: 'Низький залишок',
};

type Tab = 'org' | 'payments' | 'sms' | 'theme';

const VAT_LABELS: Record<string, string> = {
  NONE: 'Без ПДВ',
  EXCLUSIVE: 'ПДВ зверху',
  INCLUSIVE: 'ПДВ включено',
};

export default function SettingsPage() {
  useRequireAuth(['OWNER', 'ADMIN']);
  const [tab, setTab] = useState<Tab>('org');
  const [orgSettings, setOrgSettings] = useState<OrgSettings | null>(null);
  const [payments, setPayments] = useState<PaymentMethod[]>([]);
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [editingTemplate, setEditingTemplate] = useState<NotificationTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<OrgSettings>('/settings/organisation')
      .then(s => { setOrgSettings(s); applyTheme(s.brandTheme); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження налаштувань'));
    apiFetch<PaymentMethod[]>('/payment-methods')
      .then(setPayments)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження методів оплати'));
    apiFetch<NotificationTemplate[]>('/notification-templates')
      .then(setTemplates)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження шаблонів'));
  }, []);

  const saveTemplate = async () => {
    if (!editingTemplate) return;
    setSaving(true);
    try {
      const updated = await apiFetch<NotificationTemplate>(`/notification-templates/${editingTemplate.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body: editingTemplate.body, subject: editingTemplate.subject, isActive: editingTemplate.isActive }),
      });
      setTemplates(ts => ts.map(t => t.id === updated.id ? updated : t));
      setEditingTemplate(null);
      setMsg('Шаблон збережено');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження шаблону');
    } finally { setSaving(false); }
  };

  const saveOrgSettings = async () => {
    if (!orgSettings) return;
    setSaving(true);
    setMsg('');
    setError('');
    try {
      const updated = await apiFetch<OrgSettings>('/settings/organisation', {
        method: 'PATCH',
        body: JSON.stringify({
          vatMode: orgSettings.vatMode,
          invoiceDueDays: orgSettings.invoiceDueDays,
          autoArchiveDays: orgSettings.autoArchiveDays,
          defaultWarrantyDays: orgSettings.defaultWarrantyDays,
          requireClientApproval: orgSettings.requireClientApproval,
          allowPartialPayment: orgSettings.allowPartialPayment,
          brandTheme: orgSettings.brandTheme,
        }),
      });
      applyTheme(updated.brandTheme);
      setOrgSettings(updated);
      setMsg('Збережено');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSaving(false);
    }
  };

  const togglePayment = async (pm: PaymentMethod) => {
    setSaving(true);
    try {
      const updated = await apiFetch<PaymentMethod>(`/payment-methods/${pm.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !pm.isActive }),
      });
      setPayments((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-container max-w-3xl">
      <h1 className="page-title mb-6">Налаштування</h1>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border mb-6">
        {(['org', 'payments', 'sms', 'theme'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === t
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t === 'org' ? 'Організація' : t === 'payments' ? 'Методи оплати' : t === 'sms' ? 'SMS-сповіщення' : 'Оформлення'}
          </button>
        ))}
      </div>

      {msg && (
        <div className="mb-4 text-sm text-success bg-success-subtle border border-success/20 rounded-lg p-3">
          {msg}
        </div>
      )}
      {error && (
        <div className="mb-4 text-sm text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg p-3">
          {error}
        </div>
      )}

      {/* Org settings */}
      {tab === 'org' && orgSettings && (
        <div className="bg-surface rounded-xl border border-border p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Режим ПДВ</label>
            <Select
              value={orgSettings.vatMode}
              onChange={(e) => setOrgSettings({ ...orgSettings, vatMode: e.target.value })}
              className="w-auto"
            >
              {Object.entries(VAT_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </div>

          <NumberField
            label="Термін оплати рахунку (днів)"
            value={orgSettings.invoiceDueDays}
            onChange={(v) => setOrgSettings({ ...orgSettings, invoiceDueDays: v })}
            min={1}
            max={365}
          />
          <NumberField
            label="Авто-архівування (днів після закриття)"
            value={orgSettings.autoArchiveDays}
            onChange={(v) => setOrgSettings({ ...orgSettings, autoArchiveDays: v })}
            min={1}
            max={365}
          />
          <NumberField
            label="Гарантійний термін за замовчуванням (днів)"
            value={orgSettings.defaultWarrantyDays}
            onChange={(v) => setOrgSettings({ ...orgSettings, defaultWarrantyDays: v })}
            min={0}
            max={3650}
          />

          <div className="space-y-3">
            <Toggle
              label="Вимагати підтвердження клієнта"
              checked={orgSettings.requireClientApproval}
              onChange={(v) => setOrgSettings({ ...orgSettings, requireClientApproval: v })}
            />
            <Toggle
              label="Дозволити часткову оплату"
              checked={orgSettings.allowPartialPayment}
              onChange={(v) => setOrgSettings({ ...orgSettings, allowPartialPayment: v })}
            />
          </div>

          <Button onClick={saveOrgSettings} loading={saving} className="w-full">
            Зберегти
          </Button>
        </div>
      )}

      {/* SMS templates */}
      {tab === 'sms' && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Використовуйте змінні у подвійних дужках: {'{{workOrderNumber}}'}, {'{{clientName}}'}, {'{{amount}}'}
          </p>
          {templates.length === 0 && (
            <p className="text-muted-foreground text-sm">Шаблони не знайдено</p>
          )}
          {templates.map(t => (
            <div key={t.id} className="bg-surface rounded-xl border border-border p-4">
              {editingTemplate?.id === t.id ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-foreground">{EVENT_LABELS[t.eventType] ?? t.eventType}</span>
                    <span className="text-xs text-muted-foreground">{t.channel}</span>
                  </div>
                  <textarea
                    value={editingTemplate.body}
                    onChange={e => setEditingTemplate(et => et ? { ...et, body: e.target.value } : et)}
                    rows={3}
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary bg-surface text-foreground"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveTemplate} loading={saving}>
                      Зберегти
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditingTemplate(null)}>
                      Скасувати
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-foreground">{EVENT_LABELS[t.eventType] ?? t.eventType}</span>
                      <span className="text-xs px-1.5 py-0.5 bg-secondary text-muted-foreground rounded">{t.channel}</span>
                      <span className={cn(
                        'text-xs px-1.5 py-0.5 rounded',
                        t.isActive ? 'bg-success-subtle text-success' : 'bg-secondary text-muted-foreground',
                      )}>
                        {t.isActive ? 'Активний' : 'Вимкнено'}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground font-mono bg-secondary rounded p-2">{t.body}</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setEditingTemplate(t)}>
                    Редагувати
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Theme */}
      {tab === 'theme' && orgSettings && (
        <div className="bg-surface rounded-xl border border-border p-6">
          <p className="text-sm text-muted-foreground mb-4">Оберіть кольорову палітру інтерфейсу</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
            {(Object.entries(THEMES) as [ThemeName, typeof THEMES[ThemeName]][]).map(([key, theme]) => (
              <button key={key} onClick={() => { setOrgSettings({ ...orgSettings, brandTheme: key }); applyTheme(key); }}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-xl border-2 transition-all',
                  orgSettings.brandTheme === key ? 'border-foreground shadow-sm' : 'border-border hover:border-foreground/40',
                )}>
                <span className="w-8 h-8 rounded-full shrink-0" style={{ background: theme.primary }} />
                <span className="text-sm font-medium text-foreground">{theme.label}</span>
              </button>
            ))}
          </div>
          <Button onClick={saveOrgSettings} loading={saving} className="w-full">
            Зберегти тему
          </Button>
        </div>
      )}

      {/* Payment methods */}
      {tab === 'payments' && (
        <div className="bg-surface rounded-xl border border-border divide-y divide-border">
          {payments.length === 0 && (
            <p className="p-6 text-sm text-muted-foreground">Методи оплати не знайдено</p>
          )}
          {payments.map((pm) => (
            <div key={pm.id} className="flex items-center justify-between px-5 py-4">
              <div>
                <p className="text-sm font-medium text-foreground">{pm.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {pm.code}
                  {pm.requiresFiscal ? ' · фіскальний' : ''}
                </p>
              </div>
              <button
                onClick={() => togglePayment(pm)}
                className={cn(
                  'relative inline-flex h-5 w-9 rounded-full transition-colors',
                  pm.isActive ? 'bg-primary' : 'bg-border',
                )}
              >
                <span
                  className={cn(
                    'inline-block h-4 w-4 rounded-full bg-surface shadow transform transition-transform mt-0.5',
                    pm.isActive ? 'translate-x-4' : 'translate-x-0.5',
                  )}
                />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
      <label className="block text-sm font-medium text-foreground mb-1">{label}</label>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-32"
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
