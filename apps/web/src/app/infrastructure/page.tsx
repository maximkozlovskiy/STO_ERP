'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Plus, Trash2, Pencil } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import {
  DataTable, type DataTableColumn,
} from '@/components/ui/table';
import { cn, daysUntil } from '@/lib/utils';
import { getCached, setCache } from '@/lib/ref-cache';

// ─── Types ────────────────────────────────────────────────

interface Branch { id: string; name: string; address: string; timezone: string; }
interface Zone { id: string; branchId: string; name: string; type: string; }
interface Lift {
  id: string;
  zoneId: string;
  name: string;
  type: string;
  maxWeightKg: number | null;
  status: 'ACTIVE' | 'MAINTENANCE' | 'BROKEN' | 'DECOMMISSIONED';
  serialNumber?: string | null;
  purchaseDate?: string | null;
  warrantyUntil?: string | null;
  maintenanceIntervalDays?: number | null;
  lastMaintenanceDate?: string | null;
  nextMaintenanceDate?: string | null;
}
interface Warehouse { id: string; branchId: string; name: string; type: string; isMain: boolean; }

type Tab = 'branches' | 'zones' | 'lifts' | 'warehouses';

const ZONE_TYPE_LABELS: Record<string, string> = {
  MECHANICAL: 'Механічна', BODY: 'Кузовна', TIRE: 'Шиномонтажна',
  WASH: 'Мийка', ELECTRICAL: 'Електрика', OTHER: 'Інша',
};
const LIFT_TYPE_LABELS: Record<string, string> = {
  TWO_POST: '2-стійковий', FOUR_POST: '4-стійковий', ALIGNMENT: 'Розвал-сход',
  STENCIL: 'Стапель', STAND: 'Стенд', PIT: 'Яма', RAMP: 'Естакада', OTHER: 'Інший',
};
const LIFT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Активний', MAINTENANCE: 'ТО', BROKEN: 'Несправний', DECOMMISSIONED: 'Списаний',
};
const LIFT_STATUS_BADGE: Record<string, BadgeVariant> = {
  ACTIVE: 'success', MAINTENANCE: 'warning', BROKEN: 'destructive', DECOMMISSIONED: 'secondary',
};
const WAREHOUSE_TYPE_LABELS: Record<string, string> = {
  MAIN: 'Основний', WORKSHOP: 'Цеховий', TIRE_HOTEL: 'Шиновий готель', MOBILE: 'Мобільний',
};

// ─── Main Page ──────────���────────────────────────────────

export default function InfrastructurePage() {
  useRequireAuth(['OWNER', 'ADMIN']);
  const { confirm, dialogProps } = useConfirm();
  const [tab, setTab] = useState<Tab>('branches');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [lifts, setLifts] = useState<Lift[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<'branch' | 'zone' | 'lift' | 'warehouse' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState<Record<string, string>>({});
  // Bug (review): nowMs з useEffect замість new Date() у render — запобігає SSR hydration mismatch.
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => { setNowMs(Date.now()); }, []);

  const loadAll = () => {
    setLoading(true);
    // Paint instantly from sessionStorage, then refresh in parallel. This page is
    // the management source for these reference lists, so it always re-fetches
    // fresh; writing setCache after the fetch warms the shared ref-cache AND
    // propagates edits/deletes here to consumer pages (employees, work-orders,
    // inventory…) on their next mount.
    const cBranches = getCached<Branch[]>('cache:branches');
    const cZones = getCached<Zone[]>('cache:zones');
    const cLifts = getCached<Lift[]>('cache:lifts');
    const cWarehouses = getCached<Warehouse[]>('cache:warehouses');
    if (cBranches) setBranches(cBranches);
    if (cZones) setZones(cZones);
    if (cLifts) setLifts(cLifts);
    if (cWarehouses) setWarehouses(cWarehouses);
    Promise.all([
      apiFetch<Branch[]>('/branches').then(d => { setBranches(d); setCache('cache:branches', d); }),
      apiFetch<Zone[]>('/zones').then(d => { setZones(d); setCache('cache:zones', d); }),
      apiFetch<Lift[]>('/lifts').then(d => { setLifts(d); setCache('cache:lifts', d); }),
      apiFetch<Warehouse[]>('/warehouses').then(d => { setWarehouses(d); setCache('cache:warehouses', d); }),
    ]).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження')).finally(() => setLoading(false));
  };

  useEffect(() => { loadAll(); }, []);

  const openModal = (type: typeof modal, defaults: Record<string, string> = {}) => {
    setEditingId(null);
    setForm(defaults);
    setError('');
    setModal(type);
  };

  const openEditModal = (type: typeof modal, id: string, defaults: Record<string, string>) => {
    setEditingId(id);
    setForm(defaults);
    setError('');
    setModal(type);
  };

  const closeModal = () => { setModal(null); setEditingId(null); setError(''); };

  const save = async () => {
    if (modal === 'lift' && form.maxWeightKg) {
      const w = Number(form.maxWeightKg);
      if (!Number.isFinite(w) || w <= 0) { setError('Вантажність має бути додатнім числом'); return; }
    }
    setSaving(true);
    setError('');
    const method = editingId ? 'PATCH' : 'POST';
    try {
      if (modal === 'branch') {
        const url = editingId ? `/branches/${editingId}` : '/branches';
        await apiFetch<Branch>(url, { method, body: JSON.stringify({ name: form.name, address: form.address }) });
      } else if (modal === 'zone') {
        const url = editingId ? `/zones/${editingId}` : '/zones';
        // Bug #136: UpdateZoneDto не дозволяє branchId — relation FK immutable у PATCH.
        const body = editingId
          ? { name: form.name, type: form.type }
          : { branchId: form.branchId, name: form.name, type: form.type };
        await apiFetch<Zone>(url, { method, body: JSON.stringify(body) });
      } else if (modal === 'lift') {
        const w = form.maxWeightKg ? Number(form.maxWeightKg) : undefined;
        const interval = form.maintenanceIntervalDays ? Number(form.maintenanceIntervalDays) : undefined;
        const url = editingId ? `/lifts/${editingId}` : '/lifts';
        // Bug #136: UpdateLiftDto не дозволяє zoneId — relation FK immutable у PATCH.
        const commonFields = {
          name: form.name,
          type: form.type,
          maxWeightKg: w,
          status: form.status || 'ACTIVE',
          serialNumber: form.serialNumber || undefined,
          purchaseDate: form.purchaseDate || undefined,
          warrantyUntil: form.warrantyUntil || undefined,
          maintenanceIntervalDays: interval,
          lastMaintenanceDate: form.lastMaintenanceDate || undefined,
        };
        const body = editingId ? commonFields : { zoneId: form.zoneId, ...commonFields };
        await apiFetch<Lift>(url, { method, body: JSON.stringify(body) });
      } else if (modal === 'warehouse') {
        const url = editingId ? `/warehouses/${editingId}` : '/warehouses';
        // Bug #136: UpdateWarehouseDto не дозволяє branchId — relation FK immutable у PATCH.
        const body = editingId
          ? { name: form.name, type: form.type, isMain: form.isMain === 'true' }
          : { branchId: form.branchId, name: form.name, type: form.type, isMain: form.isMain === 'true' };
        await apiFetch<Warehouse>(url, { method, body: JSON.stringify(body) });
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
    if (!(await confirm({ title: 'Видалити запис?', variant: 'destructive' }))) return;
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
    { key: 'lifts', label: 'Пости' },
    { key: 'warehouses', label: 'Склади' },
  ];

  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">Інфраструктура</h1>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border mb-6">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === t.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
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
        <div className="mb-4 text-sm text-destructive-text bg-destructive-subtle border border-destructive/20 rounded-lg px-4 py-2.5">{error}</div>
      )}

      {/* BRANCHES */}
      {!loading && tab === 'branches' && (
        <Section title="Філії" onAdd={() => openModal('branch', { name: '', address: '' })}>
          <DataTable
            columns={[
              { key: 'name', label: 'Назва' },
              { key: 'address', label: 'Адреса' },
              { key: 'timezone', label: 'Часовий пояс' },
              { key: 'actions', label: '' },
            ] satisfies DataTableColumn[]}
            rows={branches.map(b => ({
              id: b.id,
              name: <span className="font-medium text-foreground">{b.name}</span>,
              address: <span className="text-muted-foreground">{b.address}</span>,
              timezone: <span className="text-muted-foreground">{b.timezone}</span>,
              actions: (
                <div className="flex items-center justify-end gap-1">
                  <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); openEditModal('branch', b.id, { name: b.name, address: b.address }); }} className="text-muted-foreground hover:text-foreground">
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); void remove('/branches', b.id); }} className="text-destructive/70 hover:text-destructive hover:bg-destructive/10">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ),
            }))}
            emptyText="Немає філій"
          />
        </Section>
      )}

      {/* ZONES */}
      {!loading && tab === 'zones' && (
        <Section title="Зони" onAdd={() => openModal('zone', { branchId: branches[0]?.id ?? '', name: '', type: 'MECHANICAL' })}>
          <DataTable
            columns={[
              { key: 'name', label: 'Назва' },
              { key: 'type', label: 'Тип' },
              { key: 'branch', label: 'Філія' },
              { key: 'actions', label: '' },
            ] satisfies DataTableColumn[]}
            rows={zones.map(z => ({
              id: z.id,
              name: <span className="font-medium text-foreground">{z.name}</span>,
              type: <span className="text-muted-foreground">{ZONE_TYPE_LABELS[z.type] ?? z.type}</span>,
              branch: <span className="text-muted-foreground">{branches.find(b => b.id === z.branchId)?.name ?? '—'}</span>,
              actions: (
                <div className="flex items-center justify-end gap-1">
                  <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); openEditModal('zone', z.id, { branchId: z.branchId, name: z.name, type: z.type }); }} className="text-muted-foreground hover:text-foreground">
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); void remove('/zones', z.id); }} className="text-destructive/70 hover:text-destructive hover:bg-destructive/10">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ),
            }))}
            emptyText="Немає зон"
          />
        </Section>
      )}

      {/* LIFTS */}
      {!loading && tab === 'lifts' && (
        <Section title="Пости" onAdd={() => openModal('lift', { zoneId: zones[0]?.id ?? '', name: '', type: 'TWO_POST', maxWeightKg: '', status: 'ACTIVE', serialNumber: '', purchaseDate: '', warrantyUntil: '', maintenanceIntervalDays: '', lastMaintenanceDate: '' })}>
          <DataTable
            columns={[
              { key: 'name', label: 'Назва' },
              { key: 'type', label: 'Тип' },
              { key: 'status', label: 'Статус' },
              { key: 'maxWeight', label: 'Вантажність, кг' },
              { key: 'zone', label: 'Зона' },
              { key: 'actions', label: '' },
            ] satisfies DataTableColumn[]}
            rows={lifts.map(l => {
              const zoneName = zones.find(z => z.id === l.zoneId)?.name ?? '—';
              const nextSoon = isWithin14Days(l.nextMaintenanceDate, nowMs);
              const hasDetail = l.nextMaintenanceDate ?? l.lastMaintenanceDate;
              return {
                id: l.id,
                name: (
                  <div>
                    <span className="font-medium text-foreground">{l.name}</span>
                    {hasDetail && (
                      <div className="mt-1 flex flex-wrap gap-x-6 gap-y-0.5 text-[12px]">
                        {l.lastMaintenanceDate && (
                          <span className="text-muted-foreground">Останнє ТО: <span className="text-foreground">{formatDate(l.lastMaintenanceDate)}</span></span>
                        )}
                        {l.nextMaintenanceDate && (
                          <span className={cn(nextSoon ? 'text-warning font-medium' : 'text-muted-foreground')}>
                            Наступне ТО: <span className={cn('font-medium', nextSoon ? 'text-warning' : 'text-foreground')}>{formatDate(l.nextMaintenanceDate)}</span>
                            {nextSoon && <span className="ml-1 text-[11px]">(незабаром)</span>}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ),
                type: <span className="text-muted-foreground">{LIFT_TYPE_LABELS[l.type] ?? l.type}</span>,
                status: <Badge variant={LIFT_STATUS_BADGE[l.status] ?? 'secondary'} dot>{LIFT_STATUS_LABELS[l.status] ?? l.status}</Badge>,
                maxWeight: <span className="text-muted-foreground">{l.maxWeightKg ?? '—'}</span>,
                zone: <span className="text-muted-foreground">{zoneName}</span>,
                actions: (
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); openEditModal('lift', l.id, {
                      zoneId: l.zoneId, name: l.name, type: l.type,
                      maxWeightKg: l.maxWeightKg != null ? String(l.maxWeightKg) : '',
                      status: l.status,
                      serialNumber: l.serialNumber ?? '',
                      purchaseDate: l.purchaseDate ? l.purchaseDate.slice(0, 10) : '',
                      warrantyUntil: l.warrantyUntil ? l.warrantyUntil.slice(0, 10) : '',
                      maintenanceIntervalDays: l.maintenanceIntervalDays != null ? String(l.maintenanceIntervalDays) : '',
                      lastMaintenanceDate: l.lastMaintenanceDate ? l.lastMaintenanceDate.slice(0, 10) : '',
                    }); }} className="text-muted-foreground hover:text-foreground">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); void remove('/lifts', l.id); }} className="text-destructive/70 hover:text-destructive hover:bg-destructive/10">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ),
              };
            })}
            emptyText="Немає постів"
          />
        </Section>
      )}

      {/* WAREHOUSES */}
      {!loading && tab === 'warehouses' && (
        <Section title="Склади" onAdd={() => openModal('warehouse', { branchId: branches[0]?.id ?? '', name: '', type: 'MAIN' })}>
          <DataTable
            columns={[
              { key: 'name', label: 'Назва' },
              { key: 'type', label: 'Тип' },
              { key: 'branch', label: 'Філія' },
              { key: 'isMain', label: 'Основний' },
              { key: 'actions', label: '' },
            ] satisfies DataTableColumn[]}
            rows={warehouses.map(w => ({
              id: w.id,
              name: <span className="font-medium text-foreground">{w.name}</span>,
              type: <span className="text-muted-foreground">{WAREHOUSE_TYPE_LABELS[w.type] ?? w.type}</span>,
              branch: <span className="text-muted-foreground">{branches.find(b => b.id === w.branchId)?.name ?? '—'}</span>,
              isMain: (
                <button
                  type="button"
                  title={w.isMain ? 'Основний склад' : 'Зробити основним'}
                  onClick={async e => {
                    e.stopPropagation();
                    if (w.isMain) return;
                    setSaving(true); setError('');
                    try {
                      await apiFetch(`/warehouses/${w.id}`, { method: 'PATCH', body: JSON.stringify({ isMain: true }) });
                      loadAll();
                    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Помилка'); }
                    finally { setSaving(false); }
                  }}
                  className={cn('w-4 h-4 rounded border-2 flex items-center justify-center', w.isMain ? 'bg-primary border-primary' : 'border-border hover:border-primary/60')}
                >
                  {w.isMain && <span className="block w-2 h-2 rounded-sm bg-white" />}
                </button>
              ),
              actions: (
                <div className="flex items-center justify-end gap-1">
                  <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); openEditModal('warehouse', w.id, { branchId: w.branchId, name: w.name, type: w.type, isMain: w.isMain ? 'true' : '' }); }} className="text-muted-foreground hover:text-foreground">
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={e => { e.stopPropagation(); void remove('/warehouses', w.id); }} className="text-destructive/70 hover:text-destructive hover:bg-destructive/10">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ),
            }))}
            emptyText="Немає складів"
          />
        </Section>
      )}

      {/* Branch modal */}
      <Modal
        open={modal === 'branch'}
        onClose={closeModal}
        title={editingId ? 'Редагувати філію' : 'Нова філія'}
        footer={<Button onClick={save} loading={saving} disabled={!form.name || !form.address} className="w-full">Зберегти</Button>}
      >
        {error && <div className="mb-3 text-sm text-destructive-text bg-destructive-subtle border border-destructive/20 rounded-lg px-3 py-2">{error}</div>}
        <div className="space-y-4">
          <Input label="Назва" required value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Головна філія" />
          <Input label="Адреса" required value={form.address ?? ''} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} placeholder="вул. Гагаріна 12, Київ" />
        </div>
      </Modal>

      {/* Zone modal */}
      <Modal
        open={modal === 'zone'}
        onClose={closeModal}
        title={editingId ? 'Редагувати зону' : 'Нова зона'}
        footer={<Button onClick={save} loading={saving} disabled={!form.name || !form.branchId} className="w-full">Зберегти</Button>}
      >
        {error && <div className="mb-3 text-sm text-destructive-text bg-destructive-subtle border border-destructive/20 rounded-lg px-3 py-2">{error}</div>}
        <div className="space-y-4">
          <Select label="Філія" required value={form.branchId ?? ''} onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
          <Input label="Назва" required value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Механічна зона А" />
          <Select label="Тип" required value={form.type ?? 'MECHANICAL'} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
            {Object.entries(ZONE_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </div>
      </Modal>

      {/* Lift modal */}
      <Modal
        open={modal === 'lift'}
        onClose={closeModal}
        title={editingId ? 'Редагувати пост' : 'Новий пост'}
        footer={<Button onClick={save} loading={saving} disabled={!form.name || !form.zoneId} className="w-full">Зберегти</Button>}
      >
        {error && <div className="mb-3 text-sm text-destructive-text bg-destructive-subtle border border-destructive/20 rounded-lg px-3 py-2">{error}</div>}
        <div className="space-y-4">
          <Select label="Зона" required value={form.zoneId ?? ''} onChange={e => setForm(f => ({ ...f, zoneId: e.target.value }))}>
            {zones.map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
          </Select>
          <Input label="Назва" required value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Пост №1" />
          <Select label="Тип" required value={form.type ?? 'TWO_POST'} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
            {Object.entries(LIFT_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Select label="Статус" required value={form.status ?? 'ACTIVE'} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
            {Object.entries(LIFT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Input label="Вантажність, кг" type="number" value={form.maxWeightKg ?? ''} onChange={e => setForm(f => ({ ...f, maxWeightKg: e.target.value }))} placeholder="3500" />
          <Input label="Серійний номер" value={form.serialNumber ?? ''} onChange={e => setForm(f => ({ ...f, serialNumber: e.target.value }))} placeholder="SN-12345" />
          <div className="grid grid-cols-2 gap-3">
            <DatePickerInput label="Дата купівлі" value={form.purchaseDate ?? ''} onChange={v => setForm(f => ({ ...f, purchaseDate: v }))} />
            <DatePickerInput label="Гарантія до" value={form.warrantyUntil ?? ''} onChange={v => setForm(f => ({ ...f, warrantyUntil: v }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Інтервал ТО (днів)" type="number" value={form.maintenanceIntervalDays ?? ''} onChange={e => setForm(f => ({ ...f, maintenanceIntervalDays: e.target.value }))} placeholder="180" />
            <DatePickerInput label="Дата останнього ТО" value={form.lastMaintenanceDate ?? ''} onChange={v => setForm(f => ({ ...f, lastMaintenanceDate: v }))} />
          </div>
        </div>
      </Modal>

      {/* Warehouse modal */}
      <Modal
        open={modal === 'warehouse'}
        onClose={closeModal}
        title={editingId ? 'Редагувати склад' : 'Новий склад'}
        footer={<Button onClick={save} loading={saving} disabled={!form.name || !form.branchId} className="w-full">Зберегти</Button>}
      >
        {error && <div className="mb-3 text-sm text-destructive-text bg-destructive-subtle border border-destructive/20 rounded-lg px-3 py-2">{error}</div>}
        <div className="space-y-4">
          <Select label="Філія" required value={form.branchId ?? ''} onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
          <Input label="Назва" required value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Основний склад" />
          <Select label="Тип" required value={form.type ?? 'MAIN'} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
            {Object.entries(WAREHOUSE_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <WarehouseMainCheckbox
            checked={form.isMain === 'true'}
            onChange={checked => setForm(f => ({ ...f, isMain: checked ? 'true' : '' }))}
            warehouses={warehouses}
            editingId={editingId}
          />
        </div>
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

// ─── Small components ────────────────────────────────────

function WarehouseMainCheckbox({
  checked, onChange, warehouses, editingId,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  warehouses: Warehouse[];
  editingId: string | null;
}) {
  const currentMain = warehouses.find(w => w.isMain);
  const anotherMainExists = !!currentMain && editingId !== currentMain.id;
  return (
    <>
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
        <input
          type="checkbox"
          checked={checked}
          onChange={e => onChange(e.target.checked)}
          className="w-4 h-4 accent-primary"
        />
        <span className="text-foreground">Основний склад</span>
      </label>
      {checked && anotherMainExists && (
        <p className="text-xs text-warning-text bg-warning-subtle border border-warning-border rounded-lg px-3 py-2">
          «{currentMain.name}» буде знятий з основного
        </p>
      )}
    </>
  );
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function isWithin14Days(value: string | null | undefined, nowMs: number): boolean {
  const diff = daysUntil(value, nowMs);
  return diff !== null && diff >= 0 && diff <= 14;
}


function Section({ title, onAdd, children }: { title: string; onAdd: () => void; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <Button size="sm" onClick={onAdd} leftIcon={<Plus className="h-4 w-4" />}>
          Додати
        </Button>
      </div>
      {children}
    </div>
  );
}
