'use client';

import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';

interface OrgSettings {
  orgId: string;
  currency: string;
  vatMode: string;
  invoiceDueDays: number;
  autoArchiveDays: number;
  defaultWarrantyDays: number;
  requireClientApproval: boolean;
  allowPartialPayment: boolean;
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

type Tab = 'org' | 'payments';

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
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<OrgSettings>('/settings/organisation').then(setOrgSettings).catch(console.error);
    apiFetch<PaymentMethod[]>('/payment-methods').then(setPayments).catch(console.error);
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
          vatMode: orgSettings.vatMode,
          invoiceDueDays: orgSettings.invoiceDueDays,
          autoArchiveDays: orgSettings.autoArchiveDays,
          defaultWarrantyDays: orgSettings.defaultWarrantyDays,
          requireClientApproval: orgSettings.requireClientApproval,
          allowPartialPayment: orgSettings.allowPartialPayment,
        }),
      });
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
        {(['org', 'payments'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t === 'org' ? 'Організація' : 'Методи оплати'}
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
