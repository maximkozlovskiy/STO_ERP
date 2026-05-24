'use client';

import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';

// ─── Types ───────────────────────────────────────────────

interface Employee {
  id: string; firstName: string; lastName: string;
  role: string; phone: string | null;
  rateScheme: { type: string; params: Record<string, number> };
  zoneIds: string[]; liftIds: string[]; workCategoryIds: string[];
}
interface Zone { id: string; name: string; type: string; }
interface Lift { id: string; name: string; type: string; }
interface WorkCategory { id: string; name: string; parentId: string | null; children: WorkCategory[]; }

const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Власник', ADMIN: 'Адміністратор', RECEPTIONIST: 'Приймальник',
  MECHANIC: 'Механік', STOREKEEPER: 'Комірник', ACCOUNTANT: 'Бухгалтер', CLIENT: 'Клієнт',
};
const RATE_LABELS: Record<string, string> = {
  percent_normo: '% від норма-год', fixed_plus_bonus: 'Ставка + бонус',
};

// ─── Modal ───────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg my-4">
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

function CheckboxList({ label, items, selected, onChange }: {
  label: string; items: { id: string; name: string }[];
  selected: string[]; onChange: (ids: string[]) => void;
}) {
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
  return (
    <div className="mb-3">
      <label className="block text-sm font-medium text-gray-700 mb-2">{label}</label>
      <div className="border border-gray-200 rounded-lg max-h-36 overflow-y-auto divide-y">
        {items.length === 0 && <p className="px-3 py-2 text-xs text-gray-400">Немає записів</p>}
        {items.map(item => (
          <label key={item.id} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer">
            <input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggle(item.id)}
              className="rounded border-gray-300" />
            <span className="text-sm text-gray-700">{item.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// Flatten category tree for checkbox list
function flattenTree(cats: WorkCategory[]): { id: string; name: string }[] {
  return cats.flatMap(c => [{ id: c.id, name: c.name }, ...flattenTree(c.children)]);
}

// ─── Main Page ───────────────────────────────────────────

export default function EmployeesPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST']);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [lifts, setLifts] = useState<Lift[]>([]);
  const [workCategories, setWorkCategories] = useState<WorkCategory[]>([]);
  const [loading, setLoading] = useState(true);

  const [modal, setModal] = useState<'create' | 'card' | null>(null);
  const [selected, setSelected] = useState<Employee | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Create form
  const [form, setForm] = useState({ firstName: '', lastName: '', role: 'MECHANIC', phone: '', rateType: 'percent_normo', percent: '40', fixedMonthly: '0', bonusPercent: '10' });

  // Assignment state (for card modal)
  const [assignedZones, setAssignedZones] = useState<string[]>([]);
  const [assignedLifts, setAssignedLifts] = useState<string[]>([]);
  const [assignedCats, setAssignedCats] = useState<string[]>([]);

  const load = () => {
    setLoading(true);
    Promise.all([
      apiFetch<Employee[]>('/employees').then(setEmployees),
      apiFetch<Zone[]>('/zones').then(setZones),
      apiFetch<Lift[]>('/lifts').then(setLifts),
      apiFetch<WorkCategory[]>('/work-categories').then(setWorkCategories),
    ]).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження')).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const openCard = (emp: Employee) => {
    setSelected(emp);
    setAssignedZones(emp.zoneIds);
    setAssignedLifts(emp.liftIds);
    setAssignedCats(emp.workCategoryIds);
    setError('');
    setModal('card');
  };

  const openCreate = () => {
    setForm({ firstName: '', lastName: '', role: 'MECHANIC', phone: '', rateType: 'percent_normo', percent: '40', fixedMonthly: '0', bonusPercent: '10' });
    setError('');
    setModal('create');
  };

  const closeModal = () => { setModal(null); setSelected(null); setError(''); };

  const buildRateScheme = () => {
    if (form.rateType === 'percent_normo') {
      return { type: 'percent_normo', params: { percent: Number(form.percent) } };
    }
    return { type: 'fixed_plus_bonus', params: { fixedMonthly: Number(form.fixedMonthly), bonusPercent: Number(form.bonusPercent) } };
  };

  const create = async () => {
    setSaving(true); setError('');
    try {
      await apiFetch<Employee>('/employees', {
        method: 'POST',
        body: JSON.stringify({ firstName: form.firstName, lastName: form.lastName, role: form.role, phone: form.phone || undefined, rateScheme: buildRateScheme() }),
      });
      closeModal(); load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const saveAssignments = async () => {
    if (!selected) return;
    setSaving(true); setError('');
    try {
      await Promise.all([
        apiFetch<void>(`/employees/${selected.id}/zones`, { method: 'POST', body: JSON.stringify({ zoneIds: assignedZones }) }),
        apiFetch<void>(`/employees/${selected.id}/lifts`, { method: 'POST', body: JSON.stringify({ liftIds: assignedLifts }) }),
        apiFetch<void>(`/employees/${selected.id}/work-categories`, { method: 'POST', body: JSON.stringify({ workCategoryIds: assignedCats }) }),
      ]);
      closeModal(); load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm('Видалити співробітника?')) return;
    setSaving(true); setError('');
    try { await apiFetch<void>(`/employees/${id}`, { method: 'DELETE' }); load(); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setSaving(false); }
  };

  const flatCats = flattenTree(workCategories);

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Співробітники</h1>
        <button onClick={openCreate} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
          + Додати
        </button>
      </div>

      {!modal && error && <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>}

      {/* Table */}
      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b">
            <tr>
              {['ПІБ', 'Посада', 'Схема нарахування', 'Зони', 'Підйомники', ''].map(h => (
                <th key={h} className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">Завантаження...</td></tr>
            )}
            {!loading && employees.map(emp => (
              <tr key={emp.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <button onClick={() => openCard(emp)} className="text-sm font-medium text-blue-600 hover:underline text-left">
                    {emp.lastName} {emp.firstName}
                  </button>
                  {emp.phone && <p className="text-xs text-gray-400 mt-0.5">{emp.phone}</p>}
                </td>
                <td className="px-4 py-3 text-sm text-gray-600">{ROLE_LABELS[emp.role] ?? emp.role}</td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {RATE_LABELS[emp.rateScheme.type] ?? emp.rateScheme.type}
                  {emp.rateScheme.type === 'percent_normo' && ` ${emp.rateScheme.params.percent}%`}
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {emp.zoneIds.length > 0
                    ? emp.zoneIds.map(id => zones.find(z => z.id === id)?.name ?? id).join(', ')
                    : <span className="text-gray-300">—</span>}
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {emp.liftIds.length > 0
                    ? emp.liftIds.map(id => lifts.find(l => l.id === id)?.name ?? id).join(', ')
                    : <span className="text-gray-300">—</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => remove(emp.id)} className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50">
                    Видалити
                  </button>
                </td>
              </tr>
            ))}
            {!loading && employees.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">Немає співробітників</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create modal */}
      {modal === 'create' && (
        <Modal title="Новий співробітник" onClose={closeModal}>
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Ім'я *" value={form.firstName} onChange={v => setForm(f => ({ ...f, firstName: v }))} placeholder="Іван" />
            <Field label="Прізвище *" value={form.lastName} onChange={v => setForm(f => ({ ...f, lastName: v }))} placeholder="Коваль" />
          </div>
          <SelectField label="Посада *" value={form.role} onChange={v => setForm(f => ({ ...f, role: v }))} options={ROLE_LABELS} />
          <Field label="Телефон" value={form.phone} onChange={v => setForm(f => ({ ...f, phone: v }))} placeholder="+38 (067) 123-45-67" />
          <SelectField label="Схема нарахування *" value={form.rateType} onChange={v => setForm(f => ({ ...f, rateType: v }))} options={RATE_LABELS} />
          {form.rateType === 'percent_normo' && (
            <Field label="Відсоток, %" value={form.percent} onChange={v => setForm(f => ({ ...f, percent: v }))} type="number" />
          )}
          {form.rateType === 'fixed_plus_bonus' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Ставка, грн/міс" value={form.fixedMonthly} onChange={v => setForm(f => ({ ...f, fixedMonthly: v }))} type="number" />
              <Field label="Бонус, %" value={form.bonusPercent} onChange={v => setForm(f => ({ ...f, bonusPercent: v }))} type="number" />
            </div>
          )}
          <button onClick={create} disabled={saving || !form.firstName || !form.lastName}
            className="w-full mt-2 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
            {saving ? 'Збереження...' : 'Зберегти'}
          </button>
        </Modal>
      )}

      {/* Card modal — assignment */}
      {modal === 'card' && selected && (
        <Modal title={`${selected.lastName} ${selected.firstName}`} onClose={closeModal}>
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          <p className="text-sm text-gray-500 mb-4">{ROLE_LABELS[selected.role]} · {RATE_LABELS[selected.rateScheme.type]}</p>
          <CheckboxList label="Зони" items={zones} selected={assignedZones} onChange={setAssignedZones} />
          <CheckboxList label="Підйомники" items={lifts} selected={assignedLifts} onChange={setAssignedLifts} />
          <CheckboxList label="Категорії робіт" items={flatCats} selected={assignedCats} onChange={setAssignedCats} />
          <button onClick={saveAssignments} disabled={saving}
            className="w-full mt-2 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
            {saving ? 'Збереження...' : 'Зберегти прив\'язки'}
          </button>
        </Modal>
      )}
    </div>
  );
}
