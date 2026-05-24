'use client';

import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

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
    if (modal === 'lift' && form.maxWeightKg) {
      const w = Number(form.maxWeightKg);
      if (isNaN(w) || w <= 0) { setError('Вантажність має бути додатнім числом'); return; }
    }
    setSaving(true);
    setError('');
    try {
      if (modal === 'branch') {
        await apiFetch<Branch>('/branches', { method: 'POST', body: JSON.stringify({ name: form.name, address: form.address }) });
      } else if (modal === 'zone') {
        await apiFetch<Zone>('/zones', { method: 'POST', body: JSON.stringify({ branchId: form.branchId, name: form.name, type: form.type }) });
      } else if (modal === 'lift') {
        const w = form.maxWeightKg ? Number(form.maxWeightKg) : undefined;
        await apiFetch<Lift>('/lifts', { method: 'POST', body: JSON.stringify({ zoneId: form.zoneId, name: form.name, type: form.type, maxWeightKg: w }) });
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
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-xl font-bold text-gray-900 mb-6">Інфраструктура</h1>

      {/* Tabs */}
      <div className="flex gap-1 border-b mb-6">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === t.key
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex justify-center py-8"><Spinner size="lg" /></div>
      )}
      {!loading && error && !modal && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">{error}</div>
      )}

      {/* BRANCHES */}
      {!loading && tab === 'branches' && (
        <Section title="Філії" onAdd={() => openModal('branch', { name: '', address: '' })}>
          <div className="bg-white rounded-xl border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Назва</TableHead>
                  <TableHead>Адреса</TableHead>
                  <TableHead>Часовий пояс</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {branches.map(b => (
                  <TableRow key={b.id}>
                    <TableCell className="font-medium text-gray-900">{b.name}</TableCell>
                    <TableCell className="text-gray-500">{b.address}</TableCell>
                    <TableCell className="text-gray-500">{b.timezone}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => remove('/branches', b.id)} className="text-red-500 hover:text-red-700">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      )}

      {/* ZONES */}
      {!loading && tab === 'zones' && (
        <Section title="Зони" onAdd={() => openModal('zone', { branchId: branches[0]?.id ?? '', name: '', type: 'MECHANICAL' })}>
          <div className="bg-white rounded-xl border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Назва</TableHead>
                  <TableHead>Тип</TableHead>
                  <TableHead>Філія</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {zones.map(z => (
                  <TableRow key={z.id}>
                    <TableCell className="font-medium text-gray-900">{z.name}</TableCell>
                    <TableCell className="text-gray-500">{ZONE_TYPE_LABELS[z.type] ?? z.type}</TableCell>
                    <TableCell className="text-gray-500">{branches.find(b => b.id === z.branchId)?.name ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => remove('/zones', z.id)} className="text-red-500 hover:text-red-700">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      )}

      {/* LIFTS */}
      {!loading && tab === 'lifts' && (
        <Section title="Підйомники" onAdd={() => openModal('lift', { zoneId: zones[0]?.id ?? '', name: '', type: 'TWO_POST', maxWeightKg: '' })}>
          <div className="bg-white rounded-xl border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Назва</TableHead>
                  <TableHead>Тип</TableHead>
                  <TableHead>Вантажність, кг</TableHead>
                  <TableHead>Зона</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lifts.map(l => (
                  <TableRow key={l.id}>
                    <TableCell className="font-medium text-gray-900">{l.name}</TableCell>
                    <TableCell className="text-gray-500">{LIFT_TYPE_LABELS[l.type] ?? l.type}</TableCell>
                    <TableCell className="text-gray-500">{l.maxWeightKg ?? '—'}</TableCell>
                    <TableCell className="text-gray-500">{zones.find(z => z.id === l.zoneId)?.name ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => remove('/lifts', l.id)} className="text-red-500 hover:text-red-700">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      )}

      {/* WAREHOUSES */}
      {!loading && tab === 'warehouses' && (
        <Section title="Склади" onAdd={() => openModal('warehouse', { branchId: branches[0]?.id ?? '', name: '', type: 'MAIN' })}>
          <div className="bg-white rounded-xl border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Назва</TableHead>
                  <TableHead>Тип</TableHead>
                  <TableHead>Філія</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {warehouses.map(w => (
                  <TableRow key={w.id}>
                    <TableCell className="font-medium text-gray-900">{w.name}</TableCell>
                    <TableCell className="text-gray-500">{WAREHOUSE_TYPE_LABELS[w.type] ?? w.type}</TableCell>
                    <TableCell className="text-gray-500">{branches.find(b => b.id === w.branchId)?.name ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => remove('/warehouses', w.id)} className="text-red-500 hover:text-red-700">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      )}

      {/* Branch modal */}
      <Modal open={modal === 'branch'} onClose={closeModal} title="Нова філія">
        {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Назва <span className="text-red-500">*</span></label>
            <Input value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Головна філія" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Адреса <span className="text-red-500">*</span></label>
            <Input value={form.address ?? ''} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} placeholder="вул. Гагаріна 12, Київ" />
          </div>
          <Button onClick={save} loading={saving} disabled={!form.name || !form.address} className="w-full">Зберегти</Button>
        </div>
      </Modal>

      {/* Zone modal */}
      <Modal open={modal === 'zone'} onClose={closeModal} title="Нова зона">
        {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Філія <span className="text-red-500">*</span></label>
            <Select value={form.branchId ?? ''} onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Назва <span className="text-red-500">*</span></label>
            <Input value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Механічна зона А" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Тип <span className="text-red-500">*</span></label>
            <Select value={form.type ?? 'MECHANICAL'} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
              {Object.entries(ZONE_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </div>
          <Button onClick={save} loading={saving} disabled={!form.name || !form.branchId} className="w-full">Зберегти</Button>
        </div>
      </Modal>

      {/* Lift modal */}
      <Modal open={modal === 'lift'} onClose={closeModal} title="Новий підйомник">
        {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Зона <span className="text-red-500">*</span></label>
            <Select value={form.zoneId ?? ''} onChange={e => setForm(f => ({ ...f, zoneId: e.target.value }))}>
              {zones.map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Назва <span className="text-red-500">*</span></label>
            <Input value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Підйомник №1" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Тип <span className="text-red-500">*</span></label>
            <Select value={form.type ?? 'TWO_POST'} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
              {Object.entries(LIFT_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Вантажність, кг</label>
            <Input type="number" value={form.maxWeightKg ?? ''} onChange={e => setForm(f => ({ ...f, maxWeightKg: e.target.value }))} placeholder="3500" />
          </div>
          <Button onClick={save} loading={saving} disabled={!form.name || !form.zoneId} className="w-full">Зберегти</Button>
        </div>
      </Modal>

      {/* Warehouse modal */}
      <Modal open={modal === 'warehouse'} onClose={closeModal} title="Новий склад">
        {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Філія <span className="text-red-500">*</span></label>
            <Select value={form.branchId ?? ''} onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Назва <span className="text-red-500">*</span></label>
            <Input value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Основний склад" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Тип <span className="text-red-500">*</span></label>
            <Select value={form.type ?? 'MAIN'} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
              {Object.entries(WAREHOUSE_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </div>
          <Button onClick={save} loading={saving} disabled={!form.name || !form.branchId} className="w-full">Зберегти</Button>
        </div>
      </Modal>
    </div>
  );
}

// ─── Small components ────────────────────────────────────

function Section({ title, onAdd, children }: { title: string; onAdd: () => void; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-gray-800">{title}</h2>
        <Button size="sm" onClick={onAdd}>
          <Plus className="h-4 w-4" />
          Додати
        </Button>
      </div>
      {children}
    </div>
  );
}
