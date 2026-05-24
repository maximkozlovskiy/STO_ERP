'use client';

import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';

// ─── Types ───────────────────────────────────────────────

interface Branch { id: string; name: string; address: string; timezone: string; }
interface Zone { id: string; branchId: string; name: string; type: string; }
interface Lift { id: string; zoneId: string; name: string; type: string; maxWeightKg: number | null; }
interface Warehouse { id: string; branchId: string; name: string; type: string; }

type Tab = 'branches' | 'zones' | 'lifts' | 'warehouses';

const ZONE_TYPE_LABELS: Record<string, string> = {
  MECHANICAL: 'Механічна', BODY: 'Кузовна', TIRE: 'Шиномонтажна',
  WASH: 'Мийка', ELECTRICAL: 'Електрика', OTHER: 'Інша',
};
const LIFT_TYPE_LABELS: Record<string, string> = {
  TWO_POST: '2-стійковий', FOUR_POST: '4-стійковий', ALIGNMENT: 'Розвал-сход',
  STENCIL: 'Стапель', STAND: 'Стенд', OTHER: 'Інший',
};
const WAREHOUSE_TYPE_LABELS: Record<string, string> = {
  MAIN: 'Основний', WORKSHOP: 'Цеховий', TIRE_HOTEL: 'Шиновий готель', MOBILE: 'Мобільний',
};

// ─── Modal ───────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
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

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Record<string, string> }) {
  return (
    <div className="mb-3">
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        {Object.entries(options).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────

export default function InfrastructurePage() {
  useRequireAuth(['OWNER', 'ADMIN']);
  const [tab, setTab] = useState<Tab>('branches');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [lifts, setLifts] = useState<Lift[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<'branch' | 'zone' | 'lift' | 'warehouse' | null>(null);
  const [saving, setSaving] = useState(false);

  // Form state
  const [form, setForm] = useState<Record<string, string>>({});

  const loadAll = () => {
    setLoading(true);
    Promise.all([
      apiFetch<Branch[]>('/branches').then(setBranches),
      apiFetch<Zone[]>('/zones').then(setZones),
      apiFetch<Lift[]>('/lifts').then(setLifts),
      apiFetch<Warehouse[]>('/warehouses').then(setWarehouses),
    ]).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження')).finally(() => setLoading(false));
  };

  useEffect(() => { loadAll(); }, []);

  const openModal = (type: typeof modal, defaults: Record<string, string> = {}) => {
    setForm(defaults);
    setError('');
    setModal(type);
  };

  const closeModal = () => { setModal(null); setError(''); };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      if (modal === 'branch') {
        await apiFetch<Branch>('/branches', { method: 'POST', body: JSON.stringify({ name: form.name, address: form.address }) });
      } else if (modal === 'zone') {
        await apiFetch<Zone>('/zones', { method: 'POST', body: JSON.stringify({ branchId: form.branchId, name: form.name, type: form.type }) });
      } else if (modal === 'lift') {
        await apiFetch<Lift>('/lifts', { method: 'POST', body: JSON.stringify({ zoneId: form.zoneId, name: form.name, type: form.type, maxWeightKg: form.maxWeightKg ? Number(form.maxWeightKg) : undefined }) });
      } else if (modal === 'warehouse') {
        await apiFetch<Warehouse>('/warehouses', { method: 'POST', body: JSON.stringify({ branchId: form.branchId, name: form.name, type: form.type }) });
      }
      closeModal();
      loadAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (endpoint: string, id: string) => {
    if (!confirm('Видалити запис?')) return;
    setSaving(true); setError('');
    try {
      await apiFetch<void>(`${endpoint}/${id}`, { method: 'DELETE' });
      loadAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка видалення');
    } finally {
      setSaving(false);
    }
  };

  const TABS: { key: Tab; label: string }[] = [
    { key: 'branches', label: 'Філії' },
    { key: 'zones', label: 'Зони' },
    { key: 'lifts', label: 'Підйомники' },
    { key: 'warehouses', label: 'Склади' },
  ];

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Інфраструктура</h1>

      <div className="flex gap-1 border-b mb-6">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-gray-400 text-center py-8">Завантаження...</p>}
      {!loading && error && !modal && <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>}

      {/* BRANCHES */}
      {tab === 'branches' && (
        <Section title="Філії" onAdd={() => openModal('branch', { name: '', address: '' })}>
          <Table headers={['Назва', 'Адреса', 'Часовий пояс', '']}>
            {branches.map(b => (
              <tr key={b.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-sm font-medium text-gray-900">{b.name}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{b.address}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{b.timezone}</td>
                <td className="px-4 py-3 text-right">
                  <DelBtn onClick={() => remove('/branches', b.id)} />
                </td>
              </tr>
            ))}
          </Table>
        </Section>
      )}

      {/* ZONES */}
      {tab === 'zones' && (
        <Section title="Зони" onAdd={() => openModal('zone', { branchId: branches[0]?.id ?? '', name: '', type: 'MECHANICAL' })}>
          <Table headers={['Назва', 'Тип', 'Філія', '']}>
            {zones.map(z => (
              <tr key={z.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-sm font-medium text-gray-900">{z.name}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{ZONE_TYPE_LABELS[z.type] ?? z.type}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{branches.find(b => b.id === z.branchId)?.name ?? '—'}</td>
                <td className="px-4 py-3 text-right"><DelBtn onClick={() => remove('/zones', z.id)} /></td>
              </tr>
            ))}
          </Table>
        </Section>
      )}

      {/* LIFTS */}
      {tab === 'lifts' && (
        <Section title="Підйомники" onAdd={() => openModal('lift', { zoneId: zones[0]?.id ?? '', name: '', type: 'TWO_POST', maxWeightKg: '' })}>
          <Table headers={['Назва', 'Тип', 'Вантажність, кг', 'Зона', '']}>
            {lifts.map(l => (
              <tr key={l.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-sm font-medium text-gray-900">{l.name}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{LIFT_TYPE_LABELS[l.type] ?? l.type}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{l.maxWeightKg ?? '—'}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{zones.find(z => z.id === l.zoneId)?.name ?? '—'}</td>
                <td className="px-4 py-3 text-right"><DelBtn onClick={() => remove('/lifts', l.id)} /></td>
              </tr>
            ))}
          </Table>
        </Section>
      )}

      {/* WAREHOUSES */}
      {tab === 'warehouses' && (
        <Section title="Склади" onAdd={() => openModal('warehouse', { branchId: branches[0]?.id ?? '', name: '', type: 'MAIN' })}>
          <Table headers={['Назва', 'Тип', 'Філія', '']}>
            {warehouses.map(w => (
              <tr key={w.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-sm font-medium text-gray-900">{w.name}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{WAREHOUSE_TYPE_LABELS[w.type] ?? w.type}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{branches.find(b => b.id === w.branchId)?.name ?? '—'}</td>
                <td className="px-4 py-3 text-right"><DelBtn onClick={() => remove('/warehouses', w.id)} /></td>
              </tr>
            ))}
          </Table>
        </Section>
      )}

      {/* Modals */}
      {modal === 'branch' && (
        <Modal title="Нова філія" onClose={closeModal}>
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          <Field label="Назва *" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="Головна філія" />
          <Field label="Адреса *" value={form.address} onChange={v => setForm(f => ({ ...f, address: v }))} placeholder="вул. Гагаріна 12, Київ" />
          <SaveBtn saving={saving} disabled={!form.name || !form.address} onClick={save} />
        </Modal>
      )}

      {modal === 'zone' && (
        <Modal title="Нова зона" onClose={closeModal}>
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          <SelectField label="Філія *" value={form.branchId} onChange={v => setForm(f => ({ ...f, branchId: v }))}
            options={Object.fromEntries(branches.map(b => [b.id, b.name]))} />
          <Field label="Назва *" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="Механічна зона А" />
          <SelectField label="Тип *" value={form.type} onChange={v => setForm(f => ({ ...f, type: v }))} options={ZONE_TYPE_LABELS} />
          <SaveBtn saving={saving} disabled={!form.name || !form.branchId} onClick={save} />
        </Modal>
      )}

      {modal === 'lift' && (
        <Modal title="Новий підйомник" onClose={closeModal}>
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          <SelectField label="Зона *" value={form.zoneId} onChange={v => setForm(f => ({ ...f, zoneId: v }))}
            options={Object.fromEntries(zones.map(z => [z.id, z.name]))} />
          <Field label="Назва *" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="Підйомник №1" />
          <SelectField label="Тип *" value={form.type} onChange={v => setForm(f => ({ ...f, type: v }))} options={LIFT_TYPE_LABELS} />
          <Field label="Вантажність, кг" value={form.maxWeightKg} onChange={v => setForm(f => ({ ...f, maxWeightKg: v }))} placeholder="3500" type="number" />
          <SaveBtn saving={saving} disabled={!form.name || !form.zoneId} onClick={save} />
        </Modal>
      )}

      {modal === 'warehouse' && (
        <Modal title="Новий склад" onClose={closeModal}>
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          <SelectField label="Філія *" value={form.branchId} onChange={v => setForm(f => ({ ...f, branchId: v }))}
            options={Object.fromEntries(branches.map(b => [b.id, b.name]))} />
          <Field label="Назва *" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="Основний склад" />
          <SelectField label="Тип *" value={form.type} onChange={v => setForm(f => ({ ...f, type: v }))} options={WAREHOUSE_TYPE_LABELS} />
          <SaveBtn saving={saving} disabled={!form.name || !form.branchId} onClick={save} />
        </Modal>
      )}
    </div>
  );
}

// ─── Small components ────────────────────────────────────

function Section({ title, onAdd, children }: { title: string; onAdd: () => void; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-gray-800">{title}</h2>
        <button onClick={onAdd} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
          + Додати
        </button>
      </div>
      {children}
    </div>
  );
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border overflow-hidden">
      <table className="w-full text-left">
        <thead className="bg-gray-50 border-b">
          <tr>{headers.map(h => <th key={h} className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-gray-100">{children}</tbody>
      </table>
    </div>
  );
}

function DelBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50">
      Видалити
    </button>
  );
}

function SaveBtn({ saving, disabled, onClick }: { saving: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={saving || disabled}
      className="w-full mt-2 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
      {saving ? 'Збереження...' : 'Зберегти'}
    </button>
  );
}
