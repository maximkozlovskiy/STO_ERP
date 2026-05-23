'use client';

import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { THEMES, type ThemeName, applyTheme } from '@/lib/theme';

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
      .catch(e => setError(e instanceof Error ? e.message : 'Помилка завантаження налаштувань'));
    apiFetch<PaymentMethod[]>('/payment-methods')
      .then(setPayments)
      .catch(e => setError(e instanceof Error ? e.message : 'Помилка завантаження методів оплати'));
    apiFetch<NotificationTemplate[]>('/notification-templates')
      .then(setTemplates)
      .catch(e => setError(e instanceof Error ? e.message : 'Помилка завантаження шаблонів'));
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
    try {
      const updated = await apiFetch<PaymentMethod>(`/payment-methods/${pm.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !pm.isActive }),
      });
      setPayments((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Налаштування</h1>

      {/* Tabs */}
      <div className="flex gap-1 border-b mb-6">
        {(['org', 'payments', 'sms', 'theme'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t === 'org' ? 'Організація' : t === 'payments' ? 'Методи оплати' : t === 'sms' ? 'SMS-сповіщення' : 'Оформлення'}
          </button>
        ))}
      </div>

      {msg && (
        <div className="mb-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-3">
          {msg}
        </div>
      )}
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
          {error}
        </div>
      )}

      {/* Org settings */}
      {tab === 'org' && orgSettings && (
        <div className="bg-white rounded-xl border p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Режим ПДВ</label>
            <select
              value={orgSettings.vatMode}
              onChange={(e) => setOrgSettings({ ...orgSettings, vatMode: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
            >
              {Object.entries(VAT_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
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

          <button
            onClick={saveOrgSettings}
            disabled={saving}
            className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
          >
            {saving ? 'Збереження...' : 'Зберегти'}
          </button>
        </div>
      )}

      {/* SMS templates */}
      {tab === 'sms' && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            Використовуйте змінні у подвійних дужках: {'{{workOrderNumber}}'}, {'{{clientName}}'}, {'{{amount}}'}
          </p>
          {templates.length === 0 && (
            <p className="text-gray-400 text-sm">Шаблони не знайдено</p>
          )}
          {templates.map(t => (
            <div key={t.id} className="bg-white rounded-xl border border-gray-200 p-4">
              {editingTemplate?.id === t.id ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-900">{EVENT_LABELS[t.eventType] ?? t.eventType}</span>
                    <span className="text-xs text-gray-400">{t.channel}</span>
                  </div>
                  <textarea
                    value={editingTemplate.body}
                    onChange={e => setEditingTemplate(et => et ? { ...et, body: e.target.value } : et)}
                    rows={3}
                    className="w-full px-3 py-2 border rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <div className="flex gap-2">
                    <button onClick={saveTemplate} disabled={saving}
                      className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50">
                      {saving ? 'Збереження...' : 'Зберегти'}
                    </button>
                    <button onClick={() => setEditingTemplate(null)}
                      className="px-3 py-1.5 bg-gray-100 text-gray-600 text-xs font-medium rounded-lg hover:bg-gray-200">
                      Скасувати
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-gray-900">{EVENT_LABELS[t.eventType] ?? t.eventType}</span>
                      <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded">{t.channel}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${t.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}>
                        {t.isActive ? 'Активний' : 'Вимкнено'}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 font-mono bg-gray-50 rounded p-2">{t.body}</p>
                  </div>
                  <button onClick={() => setEditingTemplate(t)}
                    className="text-xs text-blue-600 hover:text-blue-800 font-medium whitespace-nowrap">
                    Редагувати
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Theme */}
      {tab === 'theme' && orgSettings && (
        <div className="bg-white rounded-xl border p-6">
          <p className="text-sm text-gray-500 mb-4">Оберіть кольорову палітру інтерфейсу</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
            {(Object.entries(THEMES) as [ThemeName, typeof THEMES[ThemeName]][]).map(([key, theme]) => (
              <button key={key} onClick={() => { setOrgSettings({ ...orgSettings, brandTheme: key }); applyTheme(key); }}
                className={`flex items-center gap-3 p-3 rounded-xl border-2 transition-all ${
                  orgSettings.brandTheme === key ? 'border-gray-900 shadow-sm' : 'border-gray-200 hover:border-gray-300'
                }`}>
                <span className="w-8 h-8 rounded-full shrink-0" style={{ background: theme.primary }} />
                <span className="text-sm font-medium text-gray-700">{theme.label}</span>
              </button>
            ))}
          </div>
          <button onClick={saveOrgSettings} disabled={saving}
            className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
            {saving ? 'Збереження...' : 'Зберегти тему'}
          </button>
        </div>
      )}

      {/* Payment methods */}
      {tab === 'payments' && (
        <div className="bg-white rounded-xl border divide-y">
          {payments.length === 0 && (
            <p className="p-6 text-sm text-gray-500">Методи оплати не знайдено</p>
          )}
          {payments.map((pm) => (
            <div key={pm.id} className="flex items-center justify-between px-5 py-4">
              <div>
                <p className="text-sm font-medium text-gray-900">{pm.name}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {pm.code}
                  {pm.requiresFiscal ? ' · фіскальний' : ''}
                </p>
              </div>
              <button
                onClick={() => togglePayment(pm)}
                className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${
                  pm.isActive ? 'bg-blue-600' : 'bg-gray-300'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5 ${
                    pm.isActive ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
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
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-32 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
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
      <span className="text-sm text-gray-700">{label}</span>
      <button
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${
          checked ? 'bg-blue-600' : 'bg-gray-300'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5 ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}
