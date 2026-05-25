'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

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
      if (!Number.isFinite(w) || w <= 0) { setError('Вантажність має бути додатнім числом'); return; }
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
        const interval = form.maintenanceIntervalDays ? Number(form.maintenanceIntervalDays) : undefined;
        await apiFetch<Lift>('/lifts', {
          method: 'POST',
          body: JSON.stringify({
            zoneId: form.zoneId,
            name: form.name,
            type: form.type,
            maxWeightKg: w,
            status: form.status || 'ACTIVE',
            serialNumber: form.serialNumber || undefined,
            maintenanceIntervalDays: interval,
          }),
        });
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
          <div className="bg-surface rounded-xl border border-border overflow-hidden">
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
                    <TableCell className="font-medium text-foreground">{b.name}</TableCell>
                    <TableCell className="text-muted-foreground">{b.address}</TableCell>
                    <TableCell className="text-muted-foreground">{b.timezone}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => remove('/branches', b.id)} className="text-destructive/60 hover:text-destructive">
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
          <div className="bg-surface rounded-xl border border-border overflow-hidden">
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
                    <TableCell className="font-medium text-foreground">{z.name}</TableCell>
                    <TableCell className="text-muted-foreground">{ZONE_TYPE_LABELS[z.type] ?? z.type}</TableCell>
                    <TableCell className="text-muted-foreground">{branches.find(b => b.id === z.branchId)?.name ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => remove('/zones', z.id)} className="text-destructive/60 hover:text-destructive">
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
        <Section title="Підйомники" onAdd={() => openModal('lift', { zoneId: zones[0]?.id ?? '', name: '', type: 'TWO_POST', maxWeightKg: '', status: 'ACTIVE', serialNumber: '', maintenanceIntervalDays: '' })}>
          <div className="bg-surface rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Назва</TableHead>
                  <TableHead>Тип</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead>Вантажність, кг</TableHead>
                  <TableHead>Зона</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lifts.map(l => (
                  <LiftRow key={l.id} lift={l} zoneName={zones.find(z => z.id === l.zoneId)?.name ?? '—'} onRemove={() => remove('/lifts', l.id)} />
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      )}

      {/* WAREHOUSES */}
      {!loading && tab === 'warehouses' && (
        <Section title="Склади" onAdd={() => openModal('warehouse', { branchId: branches[0]?.id ?? '', name: '', type: 'MAIN' })}>
          <div className="bg-surface rounded-xl border border-border overflow-hidden">
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
                    <TableCell className="font-medium text-foreground">{w.name}</TableCell>
                    <TableCell className="text-muted-foreground">{WAREHOUSE_TYPE_LABELS[w.type] ?? w.type}</TableCell>
                    <TableCell className="text-muted-foreground">{branches.find(b => b.id === w.branchId)?.name ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => remove('/warehouses', w.id)} className="text-destructive/60 hover:text-destructive">
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
      <Modal
        open={modal === 'branch'}
        onClose={closeModal}
        title="Нова філія"
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
        title="Нова зона"
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
        title="Новий підйомник"
        footer={<Button onClick={save} loading={saving} disabled={!form.name || !form.zoneId} className="w-full">Зберегти</Button>}
      >
        {error && <div className="mb-3 text-sm text-destructive-text bg-destructive-subtle border border-destructive/20 rounded-lg px-3 py-2">{error}</div>}
        <div className="space-y-4">
          <Select label="Зона" required value={form.zoneId ?? ''} onChange={e => setForm(f => ({ ...f, zoneId: e.target.value }))}>
            {zones.map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
          </Select>
          <Input label="Назва" required value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Підйомник №1" />
          <Select label="Тип" required value={form.type ?? 'TWO_POST'} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
            {Object.entries(LIFT_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Select label="Статус" required value={form.status ?? 'ACTIVE'} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
            {Object.entries(LIFT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Input label="Вантажність, кг" type="number" value={form.maxWeightKg ?? ''} onChange={e => setForm(f => ({ ...f, maxWeightKg: e.target.value }))} placeholder="3500" />
          <Input label="Серійний номер" value={form.serialNumber ?? ''} onChange={e => setForm(f => ({ ...f, serialNumber: e.target.value }))} placeholder="SN-12345" />
          <Input label="Інтервал ТО, днів" type="number" value={form.maintenanceIntervalDays ?? ''} onChange={e => setForm(f => ({ ...f, maintenanceIntervalDays: e.target.value }))} placeholder="180" />
        </div>
      </Modal>

      {/* Warehouse modal */}
      <Modal
        open={modal === 'warehouse'}
        onClose={closeModal}
        title="Новий склад"
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
        </div>
      </Modal>
    </div>
  );
}

// ─── Small components ────────────────────────────────────

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function isWithin14Days(value: string | null | undefined): boolean {
  if (!value) return false;
  const d = new Date(value);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  return diffMs >= 0 && diffMs <= 14 * 24 * 60 * 60 * 1000;
}

function LiftRow({ lift, zoneName, onRemove }: { lift: Lift; zoneName: string; onRemove: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = lift.nextMaintenanceDate ?? lift.lastMaintenanceDate;
  const nextSoon = isWithin14Days(lift.nextMaintenanceDate);

  return (
    <>
      <TableRow
        className={cn(hasDetail && 'cursor-pointer select-none')}
        onClick={hasDetail ? () => setExpanded(v => !v) : undefined}
      >
        <TableCell className="font-medium text-foreground">{lift.name}</TableCell>
        <TableCell className="text-muted-foreground">{LIFT_TYPE_LABELS[lift.type] ?? lift.type}</TableCell>
        <TableCell>
          <Badge variant={LIFT_STATUS_BADGE[lift.status] ?? 'secondary'} dot>
            {LIFT_STATUS_LABELS[lift.status] ?? lift.status}
          </Badge>
        </TableCell>
        <TableCell className="text-muted-foreground">{lift.maxWeightKg ?? '—'}</TableCell>
        <TableCell className="text-muted-foreground">{zoneName}</TableCell>
        <TableCell className="text-right">
          <Button
            variant="ghost"
            size="sm"
            onClick={e => { e.stopPropagation(); onRemove(); }}
            className="text-destructive/60 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </TableCell>
      </TableRow>
      {expanded && hasDetail && (
        <TableRow>
          <TableCell colSpan={6} className="bg-surface-subtle px-6 py-3">
            <div className="flex flex-wrap gap-x-8 gap-y-1 text-sm">
              {lift.lastMaintenanceDate && (
                <span className="text-muted-foreground">
                  Останнє ТО:{' '}
                  <span className="text-foreground font-medium">{formatDate(lift.lastMaintenanceDate)}</span>
                </span>
              )}
              {lift.nextMaintenanceDate && (
                <span className={cn('text-muted-foreground', nextSoon && 'text-warning font-medium')}>
                  Наступне ТО:{' '}
                  <span className={cn('font-medium', nextSoon ? 'text-warning' : 'text-foreground')}>
                    {formatDate(lift.nextMaintenanceDate)}
                  </span>
                  {nextSoon && <span className="ml-1 text-xs">(незабаром)</span>}
                </span>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
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
