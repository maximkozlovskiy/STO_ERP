'use client';

import { useEffect, useState } from 'react';
import { Plus, Users, Trash2, Eye, EyeOff, Search } from 'lucide-react';
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
import { DetailPanel } from '@/components/ui/detail-panel';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────

interface Employee {
  id: string; firstName: string; lastName: string;
  role: string; phone: string | null;
  deletedAt: string | null;
  rateScheme?: { type: string; params: Record<string, number> };
  zoneIds: string[]; liftIds: string[]; workCategoryIds: string[];
  status: 'ACTIVE' | 'ON_LEAVE' | 'FIRED';
  email?: string | null;
  dateOfHire?: string | null;
  dateOfFire?: string | null;
}
interface Zone { id: string; name: string; type: string; }
interface Lift { id: string; name: string; type: string; }
interface WorkCategory { id: string; name: string; parentId: string | null; children: WorkCategory[]; }

const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Власник', ADMIN: 'Адміністратор', RECEPTIONIST: 'Приймальник',
  MECHANIC: 'Механік', STOREKEEPER: 'Комірник', ACCOUNTANT: 'Бухгалтер',
  CLIENT: 'Клієнт', XLSX_MANAGER: 'Менеджер імпорту',
};
const ROLE_BADGE: Record<string, BadgeVariant> = {
  OWNER: 'destructive', ADMIN: 'default', RECEPTIONIST: 'secondary',
  MECHANIC: 'warning', STOREKEEPER: 'secondary', ACCOUNTANT: 'secondary',
  CLIENT: 'secondary', XLSX_MANAGER: 'secondary',
};
const RATE_LABELS: Record<string, string> = {
  percent_normo: '% від норма-год', fixed_plus_bonus: 'Ставка + бонус',
};
const STATUS_LABELS: Record<string, string> = { ACTIVE: 'Активний', ON_LEAVE: 'У відпустці', FIRED: 'Звільнений' };
const STATUS_BADGE: Record<string, BadgeVariant> = { ACTIVE: 'success', ON_LEAVE: 'warning', FIRED: 'secondary' };

const ROLE_FILTER_OPTIONS: [string, string][] = [
  ['', 'Всі посади'],
  ['OWNER', 'Власник'],
  ['ADMIN', 'Адміністратор'],
  ['RECEPTIONIST', 'Приймальник'],
  ['MECHANIC', 'Механік'],
  ['STOREKEEPER', 'Комірник'],
  ['ACCOUNTANT', 'Бухгалтер'],
  ['XLSX_MANAGER', 'Менеджер імпорту'],
];

function CheckboxList({ label, items, selected, onChange }: {
  label: string; items: { id: string; name: string }[];
  selected: string[]; onChange: (ids: string[]) => void;
}) {
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
  return (
    <div className="mb-3">
      <label className="block text-[13px] font-medium text-foreground mb-2">{label}</label>
      <div className="border border-border rounded-lg max-h-36 overflow-y-auto divide-y divide-border">
        {items.length === 0 && <p className="px-3 py-2 text-[12px] text-muted-foreground">Немає записів</p>}
        {items.map(item => (
          <label key={item.id} className="flex items-center gap-2 px-3 py-2 hover:bg-secondary cursor-pointer">
            <input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggle(item.id)}
              className="rounded border-border" />
            <span className="text-[13px] text-foreground">{item.name}</span>
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
  const [selectedEmp, setSelectedEmp] = useState<Employee | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [markingId, setMarkingId] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);

  const [form, setForm] = useState({ firstName: '', lastName: '', role: 'MECHANIC', phone: '', rateType: 'percent_normo', percent: '40', fixedMonthly: '0', bonusPercent: '10' });

  const [assignedZones, setAssignedZones] = useState<string[]>([]);
  const [assignedLifts, setAssignedLifts] = useState<string[]>([]);
  const [assignedCats, setAssignedCats] = useState<string[]>([]);

  const load = (opts?: { search?: string; role?: string; showDeleted?: boolean }) => {
    setLoading(true);
    const params = new URLSearchParams();
    const q = opts?.search ?? search;
    const role = opts?.role ?? roleFilter;
    const deleted = opts?.showDeleted ?? showDeleted;
    if (q) params.set('q', q);
    if (role) params.set('role', role);
    if (deleted) params.set('showDeleted', 'true');
    const qs = params.toString();
    Promise.all([
      apiFetch<Employee[]>(`/employees${qs ? `?${qs}` : ''}`).then(setEmployees),
      apiFetch<Zone[]>('/zones').then(setZones),
      apiFetch<Lift[]>('/lifts').then(setLifts),
      apiFetch<WorkCategory[]>('/work-categories').then(setWorkCategories),
    ]).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження')).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-load when filters change
  useEffect(() => {
    load({ search, role: roleFilter, showDeleted });
  }, [search, roleFilter, showDeleted]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (form.rateType === 'percent_normo') {
      const pct = Number(form.percent);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) { setError('Відсоток має бути від 1 до 100'); return; }
    } else {
      const fixed = Number(form.fixedMonthly); const bonus = Number(form.bonusPercent);
      if (!Number.isFinite(fixed) || fixed < 0) { setError('Фіксована ставка повинна бути невід\'ємним числом'); return; }
      if (!Number.isFinite(bonus) || bonus < 0 || bonus > 100) { setError('Бонус має бути від 0 до 100'); return; }
    }
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

  const markForDeletion = async (id: string) => {
    if (!confirm('Помітити співробітника на видалення?')) return;
    setMarkingId(id);
    setError('');
    try {
      await apiFetch<void>(`/employees/${id}`, { method: 'DELETE' });
      if (selectedEmp?.id === id) setSelectedEmp(null);
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setMarkingId(null); }
  };

  const flatCats = flattenTree(workCategories);

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Співробітники</h1>
          <p className="page-subtitle">{employees.length} записів</p>
        </div>
        <Button onClick={openCreate} leftIcon={<Plus />}>
          Додати
        </Button>
      </div>

      {!modal && error && (
        <div className="mb-4 text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-4 py-2.5">{error}</div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Пошук за ім'ям..."
          leftElement={<Search />}
          className="flex-1 min-w-48"
        />
        <Select
          value={roleFilter}
          onChange={e => setRoleFilter(e.target.value)}
          className="w-48"
        >
          {ROLE_FILTER_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        <Button
          variant="outline"
          size="md"
          leftIcon={showDeleted ? <Eye /> : <EyeOff />}
          onClick={() => setShowDeleted(d => !d)}
          className={showDeleted ? 'border-primary text-primary' : ''}
        >
          {showDeleted ? 'Сховати видалені' : 'Показати видалені'}
        </Button>
      </div>

      {/* Table + DetailPanel */}
      <div className="flex gap-0 flex-1 min-h-0 bg-surface rounded-xl border border-border overflow-hidden">
        <div className="flex-1 min-w-0 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ПІБ</TableHead>
                <TableHead>Посада</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead>Схема нарахування</TableHead>
                <TableHead>Зони</TableHead>
                <TableHead>Підйомники</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center">
                    <div className="flex justify-center"><Spinner size="md" /></div>
                  </TableCell>
                </TableRow>
              )}
              {!loading && employees.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="p-0">
                    <EmptyState icon={Users} title="Немає співробітників" description="Додайте першого співробітника" />
                  </TableCell>
                </TableRow>
              )}
              {!loading && employees.map(emp => {
                const isDeleted = !!emp.deletedAt;
                const isMarking = markingId === emp.id;
                return (
                  <TableRow
                    key={emp.id}
                    className={cn(
                      'cursor-pointer',
                      isDeleted && 'opacity-60',
                      selectedEmp?.id === emp.id && 'bg-secondary',
                    )}
                    onClick={() => setSelectedEmp(prev => prev?.id === emp.id ? null : emp)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-foreground">
                          {emp.lastName} {emp.firstName}
                        </span>
                        {isDeleted && <Badge variant="secondary">видалено</Badge>}
                      </div>
                      {emp.phone && <p className="text-[12px] text-muted-foreground mt-0.5">{emp.phone}</p>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={ROLE_BADGE[emp.role] ?? 'secondary'}>
                        {ROLE_LABELS[emp.role] ?? emp.role}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_BADGE[emp.status] ?? 'secondary'}>{STATUS_LABELS[emp.status] ?? emp.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {emp.rateScheme
                        ? (RATE_LABELS[emp.rateScheme.type] ?? emp.rateScheme.type) + (emp.rateScheme.type === 'percent_normo' ? ` ${emp.rateScheme.params.percent}%` : '')
                        : <span className="text-foreground-faint">—</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {emp.zoneIds.length > 0
                        ? emp.zoneIds.map(id => zones.find(z => z.id === id)?.name ?? id).join(', ')
                        : <span className="text-foreground-faint">—</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {emp.liftIds.length > 0
                        ? emp.liftIds.map(id => lifts.find(l => l.id === id)?.name ?? id).join(', ')
                        : <span className="text-foreground-faint">—</span>}
                    </TableCell>
                    <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        title="Помітити на видалення"
                        disabled={isMarking || !!markingId || isDeleted}
                        onClick={() => markForDeletion(emp.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <DetailPanel
          open={!!selectedEmp}
          onClose={() => setSelectedEmp(null)}
          title={selectedEmp ? `${selectedEmp.lastName} ${selectedEmp.firstName}` : ''}
        >
          {selectedEmp && (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant={ROLE_BADGE[selectedEmp.role] ?? 'secondary'}>
                    {ROLE_LABELS[selectedEmp.role] ?? selectedEmp.role}
                  </Badge>
                  <Badge variant={STATUS_BADGE[selectedEmp.status] ?? 'secondary'}>
                    {STATUS_LABELS[selectedEmp.status] ?? selectedEmp.status}
                  </Badge>
                  {selectedEmp.deletedAt && <Badge variant="secondary">видалено</Badge>}
                </div>
                {selectedEmp.rateScheme && (
                  <p className="text-[13px] text-muted-foreground">
                    {RATE_LABELS[selectedEmp.rateScheme.type] ?? selectedEmp.rateScheme.type}
                    {selectedEmp.rateScheme.type === 'percent_normo' ? ` ${selectedEmp.rateScheme.params.percent}%` : ''}
                  </p>
                )}
                {selectedEmp.phone && (
                  <p className="text-[13px] text-muted-foreground">{selectedEmp.phone}</p>
                )}
                {selectedEmp.email && (
                  <p className="text-[13px] text-muted-foreground">{selectedEmp.email}</p>
                )}
                {selectedEmp.dateOfHire && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] text-muted-foreground">Прийнятий:</span>
                    <span className="text-[13px] text-foreground">
                      {new Date(selectedEmp.dateOfHire).toLocaleDateString('uk-UA')}
                    </span>
                  </div>
                )}
                {selectedEmp.dateOfFire && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] text-muted-foreground">Звільнений:</span>
                    <span className="text-[13px] text-foreground">
                      {new Date(selectedEmp.dateOfFire).toLocaleDateString('uk-UA')}
                    </span>
                  </div>
                )}
              </div>

              {selectedEmp.zoneIds.length > 0 && (
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Зони</p>
                  <div className="flex flex-wrap gap-1">
                    {selectedEmp.zoneIds.map(id => {
                      const z = zones.find(z => z.id === id);
                      return <Badge key={id} variant="secondary">{z?.name ?? id}</Badge>;
                    })}
                  </div>
                </div>
              )}

              {selectedEmp.liftIds.length > 0 && (
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Підйомники</p>
                  <div className="flex flex-wrap gap-1">
                    {selectedEmp.liftIds.map(id => {
                      const l = lifts.find(l => l.id === id);
                      return <Badge key={id} variant="secondary">{l?.name ?? id}</Badge>;
                    })}
                  </div>
                </div>
              )}

              {selectedEmp.workCategoryIds.length > 0 && (
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Категорії робіт</p>
                  <div className="flex flex-wrap gap-1">
                    {selectedEmp.workCategoryIds.map(id => {
                      const c = flatCats.find(c => c.id === id);
                      return <Badge key={id} variant="secondary">{c?.name ?? id}</Badge>;
                    })}
                  </div>
                </div>
              )}

              <div className="pt-2 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => openCard(selectedEmp)}
                >
                  Редагувати прив'язки
                </Button>
              </div>
            </div>
          )}
        </DetailPanel>
      </div>

      {/* Create modal */}
      <Modal open={modal === 'create'} onClose={closeModal} title="Новий співробітник"
        footer={
          <Button onClick={create} loading={saving} disabled={!form.firstName || !form.lastName} className="w-full">
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-3 py-2">{error}</div>
        )}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Ім'я"
              required
              value={form.firstName}
              onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))}
              placeholder="Іван"
            />
            <Input
              label="Прізвище"
              required
              value={form.lastName}
              onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))}
              placeholder="Коваль"
            />
          </div>
          <Select
            label="Посада"
            required
            value={form.role}
            onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
          >
            {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Input
            label="Телефон"
            value={form.phone}
            onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
            placeholder="+38 (067) 123-45-67"
          />
          <Select
            label="Схема нарахування"
            required
            value={form.rateType}
            onChange={e => setForm(f => ({ ...f, rateType: e.target.value }))}
          >
            {Object.entries(RATE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          {form.rateType === 'percent_normo' && (
            <Input
              label="Відсоток, %"
              type="number"
              value={form.percent}
              onChange={e => setForm(f => ({ ...f, percent: e.target.value }))}
            />
          )}
          {form.rateType === 'fixed_plus_bonus' && (
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Ставка, грн/міс"
                type="number"
                value={form.fixedMonthly}
                onChange={e => setForm(f => ({ ...f, fixedMonthly: e.target.value }))}
              />
              <Input
                label="Бонус, %"
                type="number"
                value={form.bonusPercent}
                onChange={e => setForm(f => ({ ...f, bonusPercent: e.target.value }))}
              />
            </div>
          )}
        </div>
      </Modal>

      {/* Card modal — assignment */}
      <Modal
        open={modal === 'card' && !!selected}
        onClose={closeModal}
        title={selected ? `${selected.lastName} ${selected.firstName}` : ''}
        footer={
          <Button onClick={saveAssignments} loading={saving} className="w-full">
            Зберегти прив'язки
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-3 py-2">{error}</div>
        )}
        {selected && (
          <div className="space-y-3">
            <p className="text-[13px] text-muted-foreground mb-4">{ROLE_LABELS[selected.role]}{selected.rateScheme ? ` · ${RATE_LABELS[selected.rateScheme.type] ?? selected.rateScheme.type}` : ''}</p>
            <CheckboxList label="Зони" items={zones} selected={assignedZones} onChange={setAssignedZones} />
            <CheckboxList label="Підйомники" items={lifts} selected={assignedLifts} onChange={setAssignedLifts} />
            <CheckboxList label="Категорії робіт" items={flatCats} selected={assignedCats} onChange={setAssignedCats} />
          </div>
        )}
      </Modal>
    </div>
  );
}
