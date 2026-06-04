'use client';

import { Suspense } from 'react';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { keepPreviousData } from '@tanstack/react-query';
import { infraKeys } from '@/hooks/api/useInfrastructure';
import { setCache } from '@/lib/ref-cache';
import { Plus, Trash2, Pencil, Eye, EyeOff, Search } from 'lucide-react';
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
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { cn, daysUntil } from '@/lib/utils';
import { fmtDate } from '@/lib/format';

// ─── Types ────────────────────────────────────────────────

interface Branch {
  id: string;
  name: string;
  address: string;
  timezone: string;
  deletedAt?: string | null;
}
interface Zone {
  id: string;
  branchId: string;
  name: string;
  type: string;
  deletedAt?: string | null;
}
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
  deletedAt?: string | null;
}
interface Warehouse {
  id: string;
  branchId: string;
  name: string;
  type: string;
  isMain: boolean;
  deletedAt?: string | null;
}

type Tab = 'branches' | 'zones' | 'lifts' | 'warehouses';

const ZONE_TYPE_LABELS: Record<string, string> = {
  MECHANICAL: 'Механічна',
  BODY: 'Кузовна',
  TIRE: 'Шиномонтажна',
  WASH: 'Мийка',
  ELECTRICAL: 'Електрика',
  OTHER: 'Інша',
};
const LIFT_TYPE_LABELS: Record<string, string> = {
  TWO_POST: '2-стійковий',
  FOUR_POST: '4-стійковий',
  ALIGNMENT: 'Розвал-сход',
  STENCIL: 'Стапель',
  STAND: 'Стенд',
  PIT: 'Яма',
  RAMP: 'Естакада',
  OTHER: 'Інший',
};
const LIFT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Активний',
  MAINTENANCE: 'ТО',
  BROKEN: 'Несправний',
  DECOMMISSIONED: 'Списаний',
};
const LIFT_STATUS_BADGE: Record<string, BadgeVariant> = {
  ACTIVE: 'success',
  MAINTENANCE: 'warning',
  BROKEN: 'destructive',
  DECOMMISSIONED: 'secondary',
};
const WAREHOUSE_TYPE_LABELS: Record<string, string> = {
  MAIN: 'Товарний',
  WORKSHOP: 'Цеховий',
  TIRE_HOTEL: 'Шиновий готель',
  MOBILE: 'Мобільний',
};

// ─── Main Page ───────────────────────────────────────────

function InfrastructurePageClient() {
  useRequireAuth(['OWNER', 'ADMIN']);
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = (searchParams.get('tab') ?? 'branches') as Tab;
  const setTab = (t: Tab) => {
    setSearch('');
    router.replace(`?tab=${t}`, { scroll: false });
  };

  const { confirm, dialogProps } = useConfirm();
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: infraKeys.all });
  const opts = { staleTime: 5 * 60_000, placeholderData: keepPreviousData } as const;

  const [showDeleted, setShowDeleted] = useState(false);
  const [search, setSearch] = useState('');

  const sd = showDeleted ? '?showDeleted=true' : '';

  const { data: branches = [], isLoading: loadingBranches } = useQuery<Branch[]>({
    queryKey: [...infraKeys.branches, showDeleted],
    queryFn: ({ signal }) =>
      apiFetch<Branch[]>(`/branches${sd}`, { signal }).then(d => {
        if (!showDeleted)
          setCache(
            'cache:branches',
            d.filter(b => !b.deletedAt),
          );
        return d;
      }),
    ...opts,
  });
  const { data: zones = [], isLoading: loadingZones } = useQuery<Zone[]>({
    queryKey: [...infraKeys.zones, showDeleted],
    queryFn: ({ signal }) =>
      apiFetch<Zone[]>(`/zones${sd}`, { signal }).then(d => {
        if (!showDeleted)
          setCache(
            'cache:zones',
            d.filter(z => !z.deletedAt),
          );
        return d;
      }),
    ...opts,
  });
  const { data: lifts = [], isLoading: loadingLifts } = useQuery<Lift[]>({
    queryKey: [...infraKeys.lifts, showDeleted],
    queryFn: ({ signal }) =>
      apiFetch<Lift[]>(`/lifts${sd}`, { signal }).then(d => {
        if (!showDeleted)
          setCache(
            'cache:lifts',
            d.filter(l => !l.deletedAt),
          );
        return d;
      }),
    ...opts,
  });
  const { data: warehouses = [], isLoading: loadingWarehouses } = useQuery<Warehouse[]>({
    queryKey: [...infraKeys.warehouses, showDeleted],
    queryFn: ({ signal }) =>
      apiFetch<Warehouse[]>(`/warehouses${sd}`, { signal }).then(d => {
        if (!showDeleted)
          setCache(
            'cache:warehouses',
            d.filter(w => !w.deletedAt),
          );
        return d;
      }),
    ...opts,
  });

  const loading = loadingBranches || loadingZones || loadingLifts || loadingWarehouses;
  const [error, setError] = useState('');
  const [modal, setModal] = useState<'branch' | 'zone' | 'lift' | 'warehouse' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  // Bug (review): nowMs з useEffect замість new Date() у render — запобігає SSR hydration mismatch.
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    setNowMs(Date.now());
  }, []);

  const loadAll = invalidate;

  const q = search.trim().toLowerCase();

  // Active-only lists for FK selects in forms (завжди без видалених)
  const activeBranches = branches.filter(b => !b.deletedAt);
  const activeZones = zones.filter(z => !z.deletedAt);

  // Filtered lists for display
  const filteredBranches = branches.filter(
    b => !q || b.name.toLowerCase().includes(q) || b.address.toLowerCase().includes(q),
  );
  const filteredZones = zones.filter(z => {
    if (q && !z.name.toLowerCase().includes(q)) return false;
    return true;
  });
  const filteredLifts = lifts.filter(l => {
    if (q && !l.name.toLowerCase().includes(q)) return false;
    return true;
  });
  const filteredWarehouses = warehouses.filter(w => {
    if (q && !w.name.toLowerCase().includes(q)) return false;
    return true;
  });

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

  const closeModal = () => {
    setModal(null);
    setEditingId(null);
    setError('');
  };

  const save = async () => {
    if (modal === 'lift' && form.maxWeightKg) {
      const w = Number(form.maxWeightKg);
      if (!Number.isFinite(w) || w <= 0) {
        setError('Вантажність має бути додатнім числом');
        return;
      }
    }
    setSaving(true);
    setError('');
    const method = editingId ? 'PATCH' : 'POST';
    try {
      if (modal === 'branch') {
        const url = editingId ? `/branches/${editingId}` : '/branches';
        await apiFetch<Branch>(url, {
          method,
          body: JSON.stringify({ name: form.name, address: form.address }),
        });
      } else if (modal === 'zone') {
        const url = editingId ? `/zones/${editingId}` : '/zones';
        // Bug #136: UpdateZoneDto не дозволяє branchId — relation FK immutable у PATCH.
        const body = editingId
          ? { name: form.name, type: form.type }
          : { branchId: form.branchId, name: form.name, type: form.type };
        await apiFetch<Zone>(url, { method, body: JSON.stringify(body) });
      } else if (modal === 'lift') {
        const w = form.maxWeightKg ? Number(form.maxWeightKg) : undefined;
        const interval = form.maintenanceIntervalDays
          ? Number(form.maintenanceIntervalDays)
          : undefined;
        const url = editingId ? `/lifts/${editingId}` : '/lifts';
        // Bug #136: UpdateLiftDto не дозволяє zoneId — relation FK immutable у PATCH.
        const commonFields = {
          name: form.name,
          type: form.type,
          maxWeightKg: w,
          // status only allowed on PATCH (UpdateLiftDto) — CreateLiftDto has no status field
          ...(editingId && { status: form.status || 'ACTIVE' }),
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
          : {
              branchId: form.branchId,
              name: form.name,
              type: form.type,
              isMain: form.isMain === 'true',
            };
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
    setSaving(true);
    setError('');
    try {
      await apiFetch<void>(`${endpoint}/${id}`, { method: 'DELETE' });
      loadAll();
    } catch (e: unknown) {
      // "не знайдено" = вже видалено (stale cache або паралельний запит) — оновлюємо список
      const msg = e instanceof Error ? e.message : '';
      const isNotFound = /не знайдено|not found/i.test(msg);
      if (isNotFound) {
        loadAll();
      } else {
        setError(msg || 'Помилка видалення');
      }
    } finally {
      setSaving(false);
    }
  };

  const TABS: { key: Tab; label: string; addLabel: string }[] = [
    { key: 'branches', label: 'Філії', addLabel: 'Філія' },
    { key: 'zones', label: 'Зони', addLabel: 'Зона' },
    { key: 'lifts', label: 'Пости', addLabel: 'Пост' },
    { key: 'warehouses', label: 'Склади', addLabel: 'Склад' },
  ];

  const ADD_ACTIONS: Record<Tab, () => void> = {
    branches: () => openModal('branch', { name: '', address: '' }),
    zones: () =>
      openModal('zone', { branchId: activeBranches[0]?.id ?? '', name: '', type: 'MECHANICAL' }),
    lifts: () =>
      openModal('lift', {
        zoneId: activeZones[0]?.id ?? '',
        name: '',
        type: 'TWO_POST',
        maxWeightKg: '',
        status: 'ACTIVE',
        serialNumber: '',
        purchaseDate: '',
        warrantyUntil: '',
        maintenanceIntervalDays: '',
        lastMaintenanceDate: '',
      }),
    warehouses: () =>
      openModal('warehouse', { branchId: activeBranches[0]?.id ?? '', name: '', type: 'MAIN' }),
  };

  const rowCls = (deletedAt?: string | null) => (deletedAt ? 'opacity-50' : '');

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Інфраструктура</h1>
        </div>
      </div>

      {/* Tabs */}
      <div className="shrink-0 flex gap-0 border-b border-border -mx-6 px-6 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0',
              tab === t.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap shrink-0">
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Пошук..."
          leftElement={<Search />}
          className="flex-1 min-w-48"
        />
        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="outline"
            size="icon-sm"
            title={showDeleted ? 'Сховати видалені' : 'Показати видалені'}
            onClick={() => setShowDeleted(v => !v)}
            className={showDeleted ? 'border-primary text-primary' : ''}
          >
            {showDeleted ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={ADD_ACTIONS[tab]}>
            {TABS.find(t => t.key === tab)?.addLabel ?? 'Додати'}
          </Button>
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-8 shrink-0">
          <Spinner size="lg" />
        </div>
      )}
      {!loading && error && !modal && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive/20 rounded-lg px-4 py-2.5 shrink-0">
          {error}
        </div>
      )}

      {/* BRANCHES */}
      {!loading && tab === 'branches' && (
        <div className="flex flex-1 min-h-0">
          <div className="flex-1 min-h-0 min-w-0 overflow-auto bg-surface rounded-xl border border-border">
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
                {filteredBranches.map(b => (
                  <TableRow key={b.id} className={rowCls(b.deletedAt)}>
                    <TableCell className="font-medium text-foreground">
                      {b.name}
                      {b.deletedAt && (
                        <Badge variant="secondary" className="ml-2 text-xs">
                          видалено
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{b.address}</TableCell>
                    <TableCell className="text-muted-foreground">{b.timezone}</TableCell>
                    <TableCell className="text-right">
                      {!b.deletedAt && (
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              openEditModal('branch', b.id, { name: b.name, address: b.address })
                            }
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => remove('/branches', b.id)}
                            className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* ZONES */}
      {!loading && tab === 'zones' && (
        <div className="flex flex-1 min-h-0">
          <div className="flex-1 min-h-0 min-w-0 overflow-auto bg-surface rounded-xl border border-border">
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
                {filteredZones.map(z => (
                  <TableRow key={z.id} className={rowCls(z.deletedAt)}>
                    <TableCell className="font-medium text-foreground">
                      {z.name}
                      {z.deletedAt && (
                        <Badge variant="secondary" className="ml-2 text-xs">
                          видалено
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {ZONE_TYPE_LABELS[z.type] ?? z.type}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {branches.find(b => b.id === z.branchId)?.name ?? '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      {!z.deletedAt && (
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              openEditModal('zone', z.id, {
                                branchId: z.branchId,
                                name: z.name,
                                type: z.type,
                              })
                            }
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => remove('/zones', z.id)}
                            className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* LIFTS */}
      {!loading && tab === 'lifts' && (
        <div className="flex flex-1 min-h-0">
          <div className="flex-1 min-h-0 min-w-0 overflow-auto bg-surface rounded-xl border border-border">
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
                {filteredLifts.map(l => (
                  <LiftRow
                    key={l.id}
                    lift={l}
                    zoneName={zones.find(z => z.id === l.zoneId)?.name ?? '—'}
                    onEdit={() =>
                      openEditModal('lift', l.id, {
                        zoneId: l.zoneId,
                        name: l.name,
                        type: l.type,
                        maxWeightKg: l.maxWeightKg != null ? String(l.maxWeightKg) : '',
                        status: l.status,
                        serialNumber: l.serialNumber ?? '',
                        purchaseDate: l.purchaseDate ? l.purchaseDate.slice(0, 10) : '',
                        warrantyUntil: l.warrantyUntil ? l.warrantyUntil.slice(0, 10) : '',
                        maintenanceIntervalDays:
                          l.maintenanceIntervalDays != null
                            ? String(l.maintenanceIntervalDays)
                            : '',
                        lastMaintenanceDate: l.lastMaintenanceDate
                          ? l.lastMaintenanceDate.slice(0, 10)
                          : '',
                      })
                    }
                    onRemove={() => remove('/lifts', l.id)}
                    nowMs={nowMs}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* WAREHOUSES */}
      {!loading && tab === 'warehouses' && (
        <div className="flex flex-1 min-h-0">
          <div className="flex-1 min-h-0 min-w-0 overflow-auto bg-surface rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Назва</TableHead>
                  <TableHead>Тип</TableHead>
                  <TableHead>Філія</TableHead>
                  <TableHead>Основний</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredWarehouses.map(w => (
                  <TableRow key={w.id} className={rowCls(w.deletedAt)}>
                    <TableCell className="font-medium text-foreground">
                      {w.name}
                      {w.deletedAt && (
                        <Badge variant="secondary" className="ml-2 text-xs">
                          видалено
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {WAREHOUSE_TYPE_LABELS[w.type] ?? w.type}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {branches.find(b => b.id === w.branchId)?.name ?? '—'}
                    </TableCell>
                    <TableCell>
                      {!w.deletedAt && (
                        <button
                          type="button"
                          title={w.isMain ? 'Основний склад' : 'Зробити основним'}
                          onClick={async () => {
                            if (w.isMain) return;
                            setSaving(true);
                            setError('');
                            try {
                              await apiFetch(`/warehouses/${w.id}`, {
                                method: 'PATCH',
                                body: JSON.stringify({ isMain: true }),
                              });
                              loadAll();
                            } catch (e: unknown) {
                              setError(e instanceof Error ? e.message : 'Помилка');
                            } finally {
                              setSaving(false);
                            }
                          }}
                          className={cn(
                            'w-4 h-4 rounded border-2 flex items-center justify-center',
                            w.isMain
                              ? 'bg-primary border-primary'
                              : 'border-border hover:border-primary/60',
                          )}
                        >
                          {w.isMain && <span className="block w-2 h-2 rounded-sm bg-white" />}
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {!w.deletedAt && (
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              openEditModal('warehouse', w.id, {
                                branchId: w.branchId,
                                name: w.name,
                                type: w.type,
                                isMain: w.isMain ? 'true' : '',
                              })
                            }
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => remove('/warehouses', w.id)}
                            className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Branch modal */}
      <Modal
        open={modal === 'branch'}
        onClose={closeModal}
        title={editingId ? 'Редагувати філію' : 'Нова філія'}
        footer={
          <Button
            onClick={save}
            loading={saving}
            disabled={!form.name || !form.address}
            className="w-full"
          >
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-3 text-sm text-destructive-text bg-destructive-subtle border border-destructive/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <div className="space-y-4">
          <Input
            label="Назва"
            required
            value={form.name ?? ''}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Головна філія"
          />
          <Input
            label="Адреса"
            required
            value={form.address ?? ''}
            onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
            placeholder="вул. Гагаріна 12, Київ"
          />
        </div>
      </Modal>

      {/* Zone modal */}
      <Modal
        open={modal === 'zone'}
        onClose={closeModal}
        title={editingId ? 'Редагувати зону' : 'Нова зона'}
        footer={
          <Button
            onClick={save}
            loading={saving}
            disabled={!form.name || !form.branchId}
            className="w-full"
          >
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-3 text-sm text-destructive-text bg-destructive-subtle border border-destructive/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <div className="space-y-4">
          <Select
            label="Філія"
            required
            value={form.branchId ?? ''}
            onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}
          >
            {activeBranches.map(b => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          <Input
            label="Назва"
            required
            value={form.name ?? ''}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Механічна зона А"
          />
          <Select
            label="Тип"
            required
            value={form.type ?? 'MECHANICAL'}
            onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
          >
            {Object.entries(ZONE_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </div>
      </Modal>

      {/* Lift modal */}
      <Modal
        open={modal === 'lift'}
        onClose={closeModal}
        title={editingId ? 'Редагувати пост' : 'Новий пост'}
        footer={
          <Button
            onClick={save}
            loading={saving}
            disabled={!form.name || !form.zoneId}
            className="w-full"
          >
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-3 text-sm text-destructive-text bg-destructive-subtle border border-destructive/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <div className="space-y-4">
          <Select
            label="Зона"
            required
            value={form.zoneId ?? ''}
            onChange={e => setForm(f => ({ ...f, zoneId: e.target.value }))}
          >
            {activeZones.map(z => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </Select>
          <Input
            label="Назва"
            required
            value={form.name ?? ''}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Пост №1"
          />
          <Select
            label="Тип"
            required
            value={form.type ?? 'TWO_POST'}
            onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
          >
            {Object.entries(LIFT_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <Select
            label="Статус"
            required
            value={form.status ?? 'ACTIVE'}
            onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
          >
            {Object.entries(LIFT_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <Input
            label="Вантажність, кг"
            type="number"
            min="0"
            value={form.maxWeightKg ?? ''}
            onChange={e => setForm(f => ({ ...f, maxWeightKg: e.target.value }))}
            placeholder="3500"
          />
          <Input
            label="Серійний номер"
            value={form.serialNumber ?? ''}
            onChange={e => setForm(f => ({ ...f, serialNumber: e.target.value }))}
            placeholder="SN-12345"
          />
          <div className="grid grid-cols-2 gap-3">
            <DatePickerInput
              label="Дата купівлі"
              value={form.purchaseDate ?? ''}
              onChange={v => setForm(f => ({ ...f, purchaseDate: v }))}
            />
            <DatePickerInput
              label="Гарантія до"
              value={form.warrantyUntil ?? ''}
              onChange={v => setForm(f => ({ ...f, warrantyUntil: v }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Інтервал ТО (днів)"
              type="number"
              min="0"
              value={form.maintenanceIntervalDays ?? ''}
              onChange={e => setForm(f => ({ ...f, maintenanceIntervalDays: e.target.value }))}
              placeholder="180"
            />
            <DatePickerInput
              label="Дата останнього ТО"
              value={form.lastMaintenanceDate ?? ''}
              onChange={v => setForm(f => ({ ...f, lastMaintenanceDate: v }))}
            />
          </div>
        </div>
      </Modal>

      {/* Warehouse modal */}
      <Modal
        open={modal === 'warehouse'}
        onClose={closeModal}
        title={editingId ? 'Редагувати склад' : 'Новий склад'}
        footer={
          <Button
            onClick={save}
            loading={saving}
            disabled={!form.name || !form.branchId}
            className="w-full"
          >
            Зберегти
          </Button>
        }
      >
        {error && (
          <div className="mb-3 text-sm text-destructive-text bg-destructive-subtle border border-destructive/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <div className="space-y-4">
          <Select
            label="Філія"
            required
            value={form.branchId ?? ''}
            onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}
          >
            {activeBranches.map(b => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          <Input
            label="Назва"
            required
            value={form.name ?? ''}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Основний склад"
          />
          <Select
            label="Тип"
            required
            value={form.type ?? 'MAIN'}
            onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
          >
            {Object.entries(WAREHOUSE_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
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

export default function InfrastructurePage() {
  return (
    <Suspense fallback={null}>
      <InfrastructurePageClient />
    </Suspense>
  );
}

// ─── Small components ────────────────────────────────────

function WarehouseMainCheckbox({
  checked,
  onChange,
  warehouses,
  editingId,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  warehouses: Warehouse[];
  editingId: string | null;
}) {
  const currentMain = warehouses.find(w => w.isMain && !w.deletedAt);
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

// Thin proxy to lib/format singleton (module-level Intl.DateTimeFormat).
const formatDate = fmtDate;

function isWithin14Days(value: string | null | undefined, nowMs: number): boolean {
  const diff = daysUntil(value, nowMs);
  return diff !== null && diff >= 0 && diff <= 14;
}

function LiftRow({
  lift,
  zoneName,
  onEdit,
  onRemove,
  nowMs,
}: {
  lift: Lift;
  zoneName: string;
  onEdit: () => void;
  onRemove: () => void;
  nowMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = lift.nextMaintenanceDate ?? lift.lastMaintenanceDate;
  const nextSoon = isWithin14Days(lift.nextMaintenanceDate, nowMs);
  const isDeleted = !!lift.deletedAt;

  return (
    <>
      <TableRow
        className={cn(
          hasDetail && !isDeleted && 'cursor-pointer select-none',
          isDeleted && 'opacity-50',
        )}
        onClick={hasDetail && !isDeleted ? () => setExpanded(v => !v) : undefined}
      >
        <TableCell className="font-medium text-foreground">
          {lift.name}
          {isDeleted && (
            <Badge variant="secondary" className="ml-2 text-xs">
              видалено
            </Badge>
          )}
        </TableCell>
        <TableCell className="text-muted-foreground">
          {LIFT_TYPE_LABELS[lift.type] ?? lift.type}
        </TableCell>
        <TableCell>
          <Badge variant={LIFT_STATUS_BADGE[lift.status] ?? 'secondary'} dot>
            {LIFT_STATUS_LABELS[lift.status] ?? lift.status}
          </Badge>
        </TableCell>
        <TableCell className="text-muted-foreground">{lift.maxWeightKg ?? '—'}</TableCell>
        <TableCell className="text-muted-foreground">{zoneName}</TableCell>
        <TableCell className="text-right">
          {!isDeleted && (
            <div className="flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={e => {
                  e.stopPropagation();
                  onEdit();
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={e => {
                  e.stopPropagation();
                  onRemove();
                }}
                className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </TableCell>
      </TableRow>
      {expanded && hasDetail && !isDeleted && (
        <TableRow>
          <TableCell colSpan={6} className="bg-surface-subtle px-6 py-3">
            <div className="flex flex-wrap gap-x-8 gap-y-1 text-sm">
              {lift.lastMaintenanceDate && (
                <span className="text-muted-foreground">
                  Останнє ТО:{' '}
                  <span className="text-foreground font-medium">
                    {formatDate(lift.lastMaintenanceDate)}
                  </span>
                </span>
              )}
              {lift.nextMaintenanceDate && (
                <span
                  className={cn('text-muted-foreground', nextSoon && 'text-warning font-medium')}
                >
                  Наступне ТО:{' '}
                  <span
                    className={cn('font-medium', nextSoon ? 'text-warning' : 'text-foreground')}
                  >
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
