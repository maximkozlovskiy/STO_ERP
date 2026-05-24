'use client';

import { useEffect, useState } from 'react';
import { Plus, Users } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';

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
const ROLE_BADGE: Record<string, BadgeVariant> = {
  OWNER: 'destructive', ADMIN: 'default', RECEPTIONIST: 'secondary',
  MECHANIC: 'warning', STOREKEEPER: 'secondary', ACCOUNTANT: 'secondary', CLIENT: 'secondary',
};
const RATE_LABELS: Record<string, string> = {
  percent_normo: '% від норма-год', fixed_plus_bonus: 'Ставка + бонус',
};

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

  const [form, setForm] = useState({ firstName: '', lastName: '', role: 'MECHANIC', phone: '', rateType: 'percent_normo', percent: '40', fixedMonthly: '0', bonusPercent: '10' });

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
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Співробітники</h1>
          <p className="text-sm text-gray-500 mt-0.5">{employees.length} записів</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" />
          Додати
        </Button>
      </div>

      {!modal && error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">{error}</div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ПІБ</TableHead>
              <TableHead>Посада</TableHead>
              <TableHead>Схема нарахування</TableHead>
              <TableHead>Зони</TableHead>
              <TableHead>Підйомники</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center">
                  <div className="flex justify-center"><Spinner size="md" /></div>
                </TableCell>
              </TableRow>
            )}
            {!loading && employees.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="p-0">
                  <EmptyState icon={Users} title="Немає співробітників" description="Додайте першого співробітника" />
                </TableCell>
              </TableRow>
            )}
            {!loading && employees.map(emp => (
              <TableRow key={emp.id}>
                <TableCell>
                  <button onClick={() => openCard(emp)} className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline text-left">
                    {emp.lastName} {emp.firstName}
                  </button>
                  {emp.phone && <p className="text-xs text-gray-400 mt-0.5">{emp.phone}</p>}
                </TableCell>
                <TableCell>
                  <Badge variant={ROLE_BADGE[emp.role] ?? 'secondary'}>
                    {ROLE_LABELS[emp.role] ?? emp.role}
                  </Badge>
                </TableCell>
                <TableCell className="text-gray-500">
                  {RATE_LABELS[emp.rateScheme.type] ?? emp.rateScheme.type}
                  {emp.rateScheme.type === 'percent_normo' && ` ${emp.rateScheme.params.percent}%`}
                </TableCell>
                <TableCell className="text-gray-500">
                  {emp.zoneIds.length > 0
                    ? emp.zoneIds.map(id => zones.find(z => z.id === id)?.name ?? id).join(', ')
                    : <span className="text-gray-300">—</span>}
                </TableCell>
                <TableCell className="text-gray-500">
                  {emp.liftIds.length > 0
                    ? emp.liftIds.map(id => lifts.find(l => l.id === id)?.name ?? id).join(', ')
                    : <span className="text-gray-300">—</span>}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="destructive" size="sm" onClick={() => remove(emp.id)}>
                    Видалити
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Create modal */}
      <Modal open={modal === 'create'} onClose={closeModal} title="Новий співробітник">
        {error && (
          <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
        )}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Ім'я <span className="text-red-500">*</span></label>
              <Input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} placeholder="Іван" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Прізвище <span className="text-red-500">*</span></label>
              <Input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} placeholder="Коваль" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Посада <span className="text-red-500">*</span></label>
            <Select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
              {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Телефон</label>
            <Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+38 (067) 123-45-67" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Схема нарахування <span className="text-red-500">*</span></label>
            <Select value={form.rateType} onChange={e => setForm(f => ({ ...f, rateType: e.target.value }))}>
              {Object.entries(RATE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </div>
          {form.rateType === 'percent_normo' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Відсоток, %</label>
              <Input type="number" value={form.percent} onChange={e => setForm(f => ({ ...f, percent: e.target.value }))} />
            </div>
          )}
          {form.rateType === 'fixed_plus_bonus' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Ставка, грн/міс</label>
                <Input type="number" value={form.fixedMonthly} onChange={e => setForm(f => ({ ...f, fixedMonthly: e.target.value }))} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Бонус, %</label>
                <Input type="number" value={form.bonusPercent} onChange={e => setForm(f => ({ ...f, bonusPercent: e.target.value }))} />
              </div>
            </div>
          )}
          <Button onClick={create} loading={saving} disabled={!form.firstName || !form.lastName} className="w-full">
            Зберегти
          </Button>
        </div>
      </Modal>

      {/* Card modal — assignment */}
      <Modal
        open={modal === 'card' && !!selected}
        onClose={closeModal}
        title={selected ? `${selected.lastName} ${selected.firstName}` : ''}
      >
        {error && (
          <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
        )}
        {selected && (
          <div className="space-y-3">
            <p className="text-sm text-gray-500 mb-4">{ROLE_LABELS[selected.role]} · {RATE_LABELS[selected.rateScheme.type]}</p>
            <CheckboxList label="Зони" items={zones} selected={assignedZones} onChange={setAssignedZones} />
            <CheckboxList label="Підйомники" items={lifts} selected={assignedLifts} onChange={setAssignedLifts} />
            <CheckboxList label="Категорії робіт" items={flatCats} selected={assignedCats} onChange={setAssignedCats} />
            <Button onClick={saveAssignments} loading={saving} className="w-full">
              Зберегти прив'язки
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
