'use client';

import { Suspense } from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { LIFT_STATUS_DESCRIPTIONS } from '@sto/shared';

/**
 * Інфраструктура: філії / зони / підйомники / склади.
 *
 * `void` перед `save()`, `remove()`, `makeMainWarehouse()` у JSX — усі три мають власний
 * try/catch, що пише текст помилки в `error` (рендериться у модалці/над таблицею), і
 * `finally { setSaving(false) }`. Відмова вже показана користувачу, тож проміс обробника
 * нікому не потрібен — `void` фіксує це явно, а не глушить правило.
 */

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

// Static tab keys — module-level так, що масив не пересоздається
// на кожен render (стабільна ref → менше work для React diff на NAV-рядках).
// Мітки резолвляться через t('tabs.*') / t('add.*') у місці рендера.
const TABS: readonly Tab[] = ['branches', 'zones', 'lifts', 'warehouses'];

// Порядок ключів для селектів (заміняє старі *_LABELS-мапи) —
// мітки беруться з namespace infrastructure (zoneType/liftType/liftStatus/warehouseType.*).
const ZONE_TYPE_KEYS: readonly string[] = [
  'MECHANICAL',
  'BODY',
  'TIRE',
  'WASH',
  'ELECTRICAL',
  'OTHER',
];
const LIFT_TYPE_KEYS: readonly string[] = [
  'TWO_POST',
  'FOUR_POST',
  'ALIGNMENT',
  'STENCIL',
  'STAND',
  'PIT',
  'RAMP',
  'OTHER',
];
const LIFT_STATUS_KEYS: readonly string[] = ['ACTIVE', 'MAINTENANCE', 'BROKEN', 'DECOMMISSIONED'];
const LIFT_STATUS_BADGE: Record<string, BadgeVariant> = {
  ACTIVE: 'success',
  MAINTENANCE: 'warning',
  BROKEN: 'destructive',
  DECOMMISSIONED: 'secondary',
};
const WAREHOUSE_TYPE_KEYS: readonly string[] = ['MAIN', 'WORKSHOP', 'TIRE_HOTEL', 'MOBILE'];

// ─── Main Page ───────────────────────────────────────────

function InfrastructurePageClient() {
  useRequireAuth(['OWNER', 'ADMIN']);
  const { t } = useTranslation('infrastructure');
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = (searchParams.get('tab') ?? 'branches') as Tab;
  const setTab = (t: Tab) => {
    setSearch('');
    setShowDeleted(false);
    router.replace(`?tab=${t}`, { scroll: false });
  };

  const { confirm, dialogProps } = useConfirm();
  const qc = useQueryClient();
  // Фонова інвалідація: TanStack сам перезапитує активні queries і сам тримає їх error-стан
  // (його показує сам список). Викличній стороні чекати нічого — тому `: void` + `void`.
  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: infraKeys.all });
  };
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

  // nowMs з useEffect замість new Date() у render — запобігає SSR hydration mismatch.
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
        setError(t('lifts.maxWeightPositive'));
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
        // UpdateZoneDto не дозволяє branchId — relation FK immutable у PATCH.
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
        // UpdateLiftDto не дозволяє zoneId — relation FK immutable у PATCH.
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
        // UpdateWarehouseDto не дозволяє branchId — relation FK immutable у PATCH.
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
      setError(e instanceof Error ? e.message : t('common.saveError'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (endpoint: string, id: string) => {
    if (!(await confirm({ title: t('common.confirmDeleteTitle'), variant: 'destructive' }))) return;
    setSaving(true);
    setError('');
    try {
      await apiFetch<void>(`${endpoint}/${id}`, { method: 'DELETE' });
      setShowDeleted(false);
      loadAll();
    } catch (e: unknown) {
      // "не знайдено" = вже видалено (stale cache або паралельний запит) — оновлюємо список
      const msg = e instanceof Error ? e.message : '';
      const isNotFound = /не знайдено|not found/i.test(msg);
      if (isNotFound) {
        loadAll();
      } else {
        setError(msg || t('common.deleteError'));
      }
    } finally {
      setSaving(false);
    }
  };

  const makeMainWarehouse = async (w: Warehouse) => {
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
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setSaving(false);
    }
  };

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
          <h1 className="page-title">{t('page.title')}</h1>
        </div>
      </div>

      {/* Tabs */}
      <div className="shrink-0 flex gap-0 border-b border-border -mx-6 px-6 overflow-x-auto">
        {TABS.map(tabKey => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0',
              tab === tabKey
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`tabs.${tabKey}`)}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap shrink-0">
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t('filters.searchPlaceholder')}
          leftElement={<Search />}
          className="flex-1 min-w-48 h-8 text-[13px]"
        />
        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="outline"
            size="icon-sm"
            title={showDeleted ? t('filters.hideDeleted') : t('filters.showDeleted')}
            onClick={() => setShowDeleted(v => !v)}
            className={showDeleted ? 'border-primary text-primary' : ''}
          >
            {showDeleted ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={ADD_ACTIONS[tab]}>
            {TABS.includes(tab) ? t(`add.${tab}`) : t('add.fallback')}
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
          <div className="table-scroll-container flex-1 min-h-0 min-w-0 overflow-auto bg-surface rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('branches.colName')}</TableHead>
                  <TableHead>{t('branches.colAddress')}</TableHead>
                  <TableHead>{t('branches.colTimezone')}</TableHead>
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
                          {t('badge.deleted')}
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
                            onClick={() => void remove('/branches', b.id)}
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
          <div className="table-scroll-container flex-1 min-h-0 min-w-0 overflow-auto bg-surface rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('zones.colName')}</TableHead>
                  <TableHead>{t('zones.colType')}</TableHead>
                  <TableHead>{t('zones.colBranch')}</TableHead>
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
                          {t('badge.deleted')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {ZONE_TYPE_KEYS.includes(z.type) ? t(`zoneType.${z.type}`) : z.type}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {branches.find(b => b.id === z.branchId)?.name ?? t('common.dash')}
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
                            onClick={() => void remove('/zones', z.id)}
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
          <div className="table-scroll-container flex-1 min-h-0 min-w-0 overflow-auto bg-surface rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('lifts.colName')}</TableHead>
                  <TableHead>{t('lifts.colType')}</TableHead>
                  <TableHead>{t('lifts.colStatus')}</TableHead>
                  <TableHead>{t('lifts.colMaxWeight')}</TableHead>
                  <TableHead>{t('lifts.colZone')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLifts.map(l => (
                  <LiftRow
                    key={l.id}
                    lift={l}
                    zoneName={zones.find(z => z.id === l.zoneId)?.name ?? t('common.dash')}
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
                    onRemove={() => void remove('/lifts', l.id)}
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
          <div className="table-scroll-container flex-1 min-h-0 min-w-0 overflow-auto bg-surface rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('warehouses.colName')}</TableHead>
                  <TableHead>{t('warehouses.colType')}</TableHead>
                  <TableHead>{t('warehouses.colBranch')}</TableHead>
                  <TableHead>{t('warehouses.colIsMain')}</TableHead>
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
                          {t('badge.deleted')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {WAREHOUSE_TYPE_KEYS.includes(w.type) ? t(`warehouseType.${w.type}`) : w.type}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {branches.find(b => b.id === w.branchId)?.name ?? t('common.dash')}
                    </TableCell>
                    <TableCell>
                      {!w.deletedAt && (
                        <button
                          type="button"
                          title={w.isMain ? t('warehouses.isMainTitle') : t('warehouses.makeMain')}
                          onClick={() => void makeMainWarehouse(w)}
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
                            onClick={() => void remove('/warehouses', w.id)}
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
        title={editingId ? t('branches.modalTitleEdit') : t('branches.modalTitleNew')}
        footer={
          <Button
            onClick={() => void save()}
            loading={saving}
            disabled={!form.name || !form.address}
            className="w-full"
          >
            {t('common.save')}
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
            label={t('branches.fieldName')}
            required
            value={form.name ?? ''}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder={t('branches.namePlaceholder')}
            className="h-8 text-[13px]"
          />
          <Input
            label={t('branches.fieldAddress')}
            required
            value={form.address ?? ''}
            onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
            placeholder={t('branches.addressPlaceholder')}
            className="h-8 text-[13px]"
          />
        </div>
      </Modal>

      {/* Zone modal */}
      <Modal
        open={modal === 'zone'}
        onClose={closeModal}
        title={editingId ? t('zones.modalTitleEdit') : t('zones.modalTitleNew')}
        footer={
          <Button
            onClick={() => void save()}
            loading={saving}
            disabled={!form.name || !form.branchId}
            className="w-full"
          >
            {t('common.save')}
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
            label={t('zones.fieldBranch')}
            required
            value={form.branchId ?? ''}
            onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}
            className="h-8 text-[13px] py-0.5 px-2 pr-7"
          >
            {activeBranches.map(b => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          <Input
            label={t('zones.fieldName')}
            required
            value={form.name ?? ''}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder={t('zones.namePlaceholder')}
            className="h-8 text-[13px]"
          />
          <Select
            label={t('zones.fieldType')}
            required
            value={form.type ?? 'MECHANICAL'}
            onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
            className="h-8 text-[13px] py-0.5 px-2 pr-7"
          >
            {ZONE_TYPE_KEYS.map(k => (
              <option key={k} value={k}>
                {t(`zoneType.${k}`)}
              </option>
            ))}
          </Select>
        </div>
      </Modal>

      {/* Lift modal */}
      <Modal
        open={modal === 'lift'}
        onClose={closeModal}
        title={editingId ? t('lifts.modalTitleEdit') : t('lifts.modalTitleNew')}
        footer={
          <Button
            onClick={() => void save()}
            loading={saving}
            disabled={!form.name || !form.zoneId}
            className="w-full"
          >
            {t('common.save')}
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
            label={t('lifts.fieldZone')}
            required
            value={form.zoneId ?? ''}
            onChange={e => setForm(f => ({ ...f, zoneId: e.target.value }))}
            className="h-8 text-[13px] py-0.5 px-2 pr-7"
          >
            {activeZones.map(z => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </Select>
          <Input
            label={t('lifts.fieldName')}
            required
            value={form.name ?? ''}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder={t('lifts.namePlaceholder')}
            className="h-8 text-[13px]"
          />
          <Select
            label={t('lifts.fieldType')}
            required
            value={form.type ?? 'TWO_POST'}
            onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
            className="h-8 text-[13px] py-0.5 px-2 pr-7"
          >
            {LIFT_TYPE_KEYS.map(k => (
              <option key={k} value={k}>
                {t(`liftType.${k}`)}
              </option>
            ))}
          </Select>
          <Select
            label={t('lifts.fieldStatus')}
            required
            value={form.status ?? 'ACTIVE'}
            onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
            className="h-8 text-[13px] py-0.5 px-2 pr-7"
          >
            {LIFT_STATUS_KEYS.map(k => (
              <option key={k} value={k}>
                {t(`liftStatus.${k}`)}
              </option>
            ))}
          </Select>
          <Input
            label={t('lifts.fieldMaxWeight')}
            type="number"
            min="0"
            value={form.maxWeightKg ?? ''}
            onChange={e => setForm(f => ({ ...f, maxWeightKg: e.target.value }))}
            placeholder={t('lifts.maxWeightPlaceholder')}
            className="h-8 text-[13px]"
          />
          <Input
            label={t('lifts.fieldSerialNumber')}
            value={form.serialNumber ?? ''}
            onChange={e => setForm(f => ({ ...f, serialNumber: e.target.value }))}
            placeholder={t('lifts.serialNumberPlaceholder')}
            className="h-8 text-[13px]"
          />
          <div className="grid grid-cols-2 gap-3">
            <DatePickerInput
              label={t('lifts.fieldPurchaseDate')}
              value={form.purchaseDate ?? ''}
              onChange={v => setForm(f => ({ ...f, purchaseDate: v }))}
            />
            <DatePickerInput
              label={t('lifts.fieldWarrantyUntil')}
              value={form.warrantyUntil ?? ''}
              onChange={v => setForm(f => ({ ...f, warrantyUntil: v }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t('lifts.fieldMaintenanceInterval')}
              type="number"
              min="0"
              value={form.maintenanceIntervalDays ?? ''}
              onChange={e => setForm(f => ({ ...f, maintenanceIntervalDays: e.target.value }))}
              placeholder={t('lifts.maintenanceIntervalPlaceholder')}
              className="h-8 text-[13px]"
            />
            <DatePickerInput
              label={t('lifts.fieldLastMaintenance')}
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
        title={editingId ? t('warehouses.modalTitleEdit') : t('warehouses.modalTitleNew')}
        footer={
          <Button
            onClick={() => void save()}
            loading={saving}
            disabled={!form.name || !form.branchId}
            className="w-full"
          >
            {t('common.save')}
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
            label={t('warehouses.fieldBranch')}
            required
            value={form.branchId ?? ''}
            onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}
            className="h-8 text-[13px] py-0.5 px-2 pr-7"
          >
            {activeBranches.map(b => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          <Input
            label={t('warehouses.fieldName')}
            required
            value={form.name ?? ''}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder={t('warehouses.namePlaceholder')}
            className="h-8 text-[13px]"
          />
          <Select
            label={t('warehouses.fieldType')}
            required
            value={form.type ?? 'MAIN'}
            onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
            className="h-8 text-[13px] py-0.5 px-2 pr-7"
          >
            {WAREHOUSE_TYPE_KEYS.map(k => (
              <option key={k} value={k}>
                {t(`warehouseType.${k}`)}
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
  const { t } = useTranslation('infrastructure');
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
        <span className="text-foreground">{t('warehouses.checkboxMain')}</span>
      </label>
      {checked && anotherMainExists && (
        <p className="text-xs text-warning-text bg-warning-subtle border border-warning-border rounded-lg px-3 py-2">
          {t('warehouses.mainWillBeUnset', { name: currentMain.name })}
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
  const { t } = useTranslation('infrastructure');
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
              {t('badge.deleted')}
            </Badge>
          )}
        </TableCell>
        <TableCell className="text-muted-foreground">
          {LIFT_TYPE_KEYS.includes(lift.type) ? t(`liftType.${lift.type}`) : lift.type}
        </TableCell>
        <TableCell>
          <Badge
            variant={LIFT_STATUS_BADGE[lift.status] ?? 'secondary'}
            dot
            tooltip={LIFT_STATUS_DESCRIPTIONS[lift.status]}
          >
            {LIFT_STATUS_KEYS.includes(lift.status) ? t(`liftStatus.${lift.status}`) : lift.status}
          </Badge>
        </TableCell>
        <TableCell className="text-muted-foreground">
          {lift.maxWeightKg ?? t('common.dash')}
        </TableCell>
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
                  {t('lifts.detailLastMaintenance')}{' '}
                  <span className="text-foreground font-medium">
                    {formatDate(lift.lastMaintenanceDate)}
                  </span>
                </span>
              )}
              {lift.nextMaintenanceDate && (
                <span
                  className={cn('text-muted-foreground', nextSoon && 'text-warning font-medium')}
                >
                  {t('lifts.detailNextMaintenance')}{' '}
                  <span
                    className={cn('font-medium', nextSoon ? 'text-warning' : 'text-foreground')}
                  >
                    {formatDate(lift.nextMaintenanceDate)}
                  </span>
                  {nextSoon && <span className="ml-1 text-xs">{t('lifts.detailSoon')}</span>}
                </span>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
