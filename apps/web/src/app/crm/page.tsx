'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';

interface Counterparty {
  id: string; type: string;
  firstName: string | null; lastName: string | null; companyName: string | null;
  phone: string | null; email: string | null; edrpou: string | null;
  vatPayer: boolean; balance: number; createdAt: string;
}
interface Paginated { items: Counterparty[]; total: number; page: number; limit: number; }

const TYPE_LABELS: Record<string, string> = { CLIENT: 'Клієнт', SUPPLIER: 'Постачальник', BOTH: 'Обидва' };
const TYPE_FILTER_OPTIONS = [['', 'Всі'], ['CLIENT', 'Клієнти'], ['SUPPLIER', 'Постачальники'], ['BOTH', 'Обидва']] as const;

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <div className="mb-3">
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
    </div>
  );
}

export default function CrmPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT']);
  const router = useRouter();
  const [data, setData] = useState<Paginated | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ type: 'CLIENT', firstName: '', lastName: '', companyName: '', phone: '', email: '', edrpou: '' });

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (search) params.set('q', search);
    if (typeFilter) params.set('type', typeFilter);
    apiFetch<Paginated>(`/counterparties?${params}`).then(setData).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження')).finally(() => setLoading(false));
  }, [page, search, typeFilter]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setSaving(true); setError('');
    try {
      await apiFetch('/counterparties', {
        method: 'POST',
        body: JSON.stringify({
          type: form.type,
          firstName: form.firstName || undefined,
          lastName: form.lastName || undefined,
          companyName: form.companyName || undefined,
          phone: form.phone || undefined,
          email: form.email || undefined,
          edrpou: form.edrpou || undefined,
        }),
      });
      setModal(false);
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const displayName = (cp: Counterparty) =>
    cp.companyName ?? [cp.lastName, cp.firstName].filter(Boolean).join(' ') ?? '—';

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Контрагенти</h1>
        <button onClick={() => { setForm({ type: 'CLIENT', firstName: '', lastName: '', companyName: '', phone: '', email: '', edrpou: '' }); setError(''); setModal(true); }}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
          + Додати
        </button>
      </div>

      {!modal && error && <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>}

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Пошук за ім'ям, телефоном, ЄДРПОУ..."
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <select value={typeFilter} onChange={e => { setTypeFilter(e.target.value); setPage(1); }}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          {TYPE_FILTER_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b">
            <tr>
              {['Контрагент', 'Тип', 'Телефон', 'ЄДРПОУ', 'Баланс, ₴', ''].map(h => (
                <th key={h} className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">Завантаження...</td></tr>
            )}
            {!loading && data?.items.map(cp => (
              <tr key={cp.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <button onClick={() => router.push(`/crm/${cp.id}`)}
                    className="text-sm font-medium text-blue-600 hover:underline text-left">
                    {displayName(cp)}
                  </button>
                  {cp.email && <p className="text-xs text-gray-400 mt-0.5">{cp.email}</p>}
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">{TYPE_LABELS[cp.type]}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{cp.phone ?? '—'}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{cp.edrpou ?? '—'}</td>
                <td className={`px-4 py-3 text-sm font-medium ${cp.balance < 0 ? 'text-red-600' : cp.balance > 0 ? 'text-green-600' : 'text-gray-500'}`}>
                  {cp.balance.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => router.push(`/crm/${cp.id}`)} className="text-xs text-blue-500 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50">
                    Картка →
                  </button>
                </td>
              </tr>
            ))}
            {!loading && data?.items.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">Нічого не знайдено</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-4">
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button key={p} onClick={() => setPage(p)}
              className={`px-3 py-1 rounded text-sm ${p === page ? 'bg-blue-600 text-white' : 'border border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
              {p}
            </button>
          ))}
        </div>
      )}

      {/* Create modal */}
      {modal && (
        <Modal title="Новий контрагент" onClose={() => setModal(false)}>
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          <div className="mb-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">Тип *</label>
            <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          {form.type !== 'SUPPLIER' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Ім'я" value={form.firstName} onChange={v => setForm(f => ({ ...f, firstName: v }))} placeholder="Іван" />
              <Field label="Прізвище" value={form.lastName} onChange={v => setForm(f => ({ ...f, lastName: v }))} placeholder="Коваль" />
            </div>
          )}
          <Field label="Назва компанії" value={form.companyName} onChange={v => setForm(f => ({ ...f, companyName: v }))} placeholder="ТОВ «Авто»" />
          <Field label="Телефон" value={form.phone} onChange={v => setForm(f => ({ ...f, phone: v }))} placeholder="+38 (067) 123-45-67" />
          <Field label="Email" value={form.email} onChange={v => setForm(f => ({ ...f, email: v }))} type="email" />
          <Field label="ЄДРПОУ" value={form.edrpou} onChange={v => setForm(f => ({ ...f, edrpou: v }))} placeholder="12345678" />
          <button onClick={create} disabled={saving}
            className="w-full mt-2 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
            {saving ? 'Збереження...' : 'Зберегти'}
          </button>
        </Modal>
      )}
    </div>
  );
}
