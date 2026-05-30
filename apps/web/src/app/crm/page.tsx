'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { useRouter } from 'next/navigation';
import { Plus, Search, Users, Eye, EyeOff, Trash2, Pencil } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Modal, AnimatedBody } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { DetailPanel, PanelField, PanelSection, type DetailPanelTab } from '@/components/ui/detail-panel';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { useDetailPanel } from '@/hooks/useDetailPanel';
import { useDetailPanelConfig } from '@/hooks/useDetailPanelConfig';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useTableColumns } from '@/hooks/useTableColumns';
import { useColumnDrag } from '@/hooks/useColumnDrag';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';

interface Counterparty {
  id: string; type: string;
  firstName: string | null; lastName: string | null; companyName: string | null;
  phone: string | null; email: string | null; edrpou: string | null;
  vatPayer: boolean; balance: number; createdAt: string;
  deletedAt: string | null;
}
interface Paginated { items: Counterparty[]; total: number; page: number; limit: number; }

interface CrmFilters extends Record<string, unknown> {
  search: string;
  typeFilter: string;
  showDeleted: boolean;
}

const TYPE_LABELS: Record<string, string> = { CLIENT: 'Клієнт', SUPPLIER: 'Постачальник', BOTH: 'Обидва' };

type ModalWorkOrder = { id: string; number: string; status: string; totalAmount: number; createdAt: string; vehicleSummary?: string | null };
const WO_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка', ESTIMATE: 'Кошторис', APPROVED: 'Затверджено',
  IN_PROGRESS: 'В роботі', ON_HOLD: 'Призупинено', COMPLETED: 'Виконано',
  INVOICED: 'Виставлено', PAID: 'Оплачено', ARCHIVED: 'Архів', CANCELLED: 'Скасовано',
};
const WO_STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary', ESTIMATE: 'info', APPROVED: 'info',
  IN_PROGRESS: 'warning', ON_HOLD: 'secondary', COMPLETED: 'success',
  INVOICED: 'default', PAID: 'success', ARCHIVED: 'secondary', CANCELLED: 'destructive',
};
const TYPE_BADGE: Record<string, BadgeVariant> = { CLIENT: 'default', SUPPLIER: 'secondary', BOTH: 'warning' };
const TYPE_FILTER_OPTIONS = [['', 'Всі'], ['CLIENT', 'Клієнти'], ['SUPPLIER', 'Постачальники'], ['BOTH', 'Обидва']] as const;

export default function CrmPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT']);
  const router = useRouter();
  const [data, setData] = useState<Paginated | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [typeFilter, setTypeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [showDeleted, setShowDeleted] = useState(false);
  const [modal, setModal] = useState(false);
  const [editingCp, setEditingCp] = useState<Counterparty | null>(null);
  const [editTab, setEditTab] = useState<'main' | 'vehicles' | 'work-orders'>('main');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [selectedCp, setSelectedCp] = useState<Counterparty | null>(null);
  const [form, setForm] = useState({
    type: 'CLIENT', firstName: '', lastName: '', companyName: '', phone: '', email: '', edrpou: '',
    vatPayer: false, notes: '', contactPerson: '',
  });

  const features = useUiFeatures();
  const { confirm, dialogProps } = useConfirm();
  const detailPanel = useDetailPanel('crm');
  const panelConfig = useDetailPanelConfig('crm');

  // ── Vehicles for selected counterparty (detail panel) ───────────────────────
  const [cpVehicles, setCpVehicles] = useState<{ id: string; make: string; model: string; year: number | null; licensePlate: string }[]>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);

  // ── Vehicles for edit modal ──────────────────────────────────────────────────
  type Vehicle = { id: string; make: string; model: string; year: number | null; licensePlate: string };
  const [modalVehicles, setModalVehicles] = useState<Vehicle[]>([]);
  const [modalVehiclesLoading, setModalVehiclesLoading] = useState(false);
  const [modalGarageId, setModalGarageId] = useState<string | null>(null);
  const [addVehicleForm, setAddVehicleForm] = useState({ make: '', model: '', year: '', licensePlate: '', vin: '' });
  const [addingVehicle, setAddingVehicle] = useState(false);
  const [showAddVehicle, setShowAddVehicle] = useState(false);
  const [deletingVehicleId, setDeletingVehicleId] = useState<string | null>(null);
  // Guards against stale fetch: openEdit runs in an event handler (not useEffect),
  // so re-opening for another CP before the first fetch resolves can overwrite
  // modalVehicles/modalGarageId with the previous CP's data. Each openEdit bumps
  // the token; resolved fetches whose token != current are discarded.
  const modalVehiclesReqRef = useRef(0);

  // ── Work orders for edit modal ───────────────────────────────────────────────
  const [modalWorkOrders, setModalWorkOrders] = useState<ModalWorkOrder[]>([]);
  const [modalWorkOrdersLoading, setModalWorkOrdersLoading] = useState(false);
  const [woError, setWoError] = useState('');
  const [vehiclesError, setVehiclesError] = useState('');
  const modalWoReqRef = useRef(0);

  // ── Column visibility ────────────────────────────────────────────────────────
  const CRM_COLUMNS = useMemo(() => [
    { key: 'name',    label: 'Контрагент',  defaultVisible: true },
    { key: 'type',    label: 'Тип',         defaultVisible: true },
    { key: 'phone',   label: 'Телефон',     defaultVisible: true },
    { key: 'edrpou',  label: 'ЄДРПОУ',     defaultVisible: false },
    { key: 'balance', label: 'Баланс, ₴',  defaultVisible: true },
  ], []);

  const { visibleKeys: colVisible, visibleColumns, orderedColumns, order, customLabels, toggle: toggleCol, reorder, renameColumn, resetConfig } = useTableColumns('crm', CRM_COLUMNS);
  const { dragProps } = useColumnDrag(visibleColumns, reorder, orderedColumns);

  // ── Saved filters ────────────────────────────────────────────────────────────
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const { saved: savedFilters, save: saveFilter, remove: removeFilter } = useSavedFilters<CrmFilters>('crm');

  const applyFilter = useCallback((preset: { id: string; filters: CrmFilters }) => {
    setSearch(preset.filters.search ?? '');
    setTypeFilter(preset.filters.typeFilter ?? '');
    setShowDeleted(preset.filters.showDeleted ?? false);
    setPage(1);
    setActiveSavedFilterId(preset.id);
  }, []);

  const handleSaveFilter = useCallback((name: string) => {
    const preset = saveFilter(name, { search, typeFilter, showDeleted });
    setActiveSavedFilterId(preset.id);
    toast.success(`Фільтр "${name}" збережено`);
  }, [saveFilter, search, typeFilter, showDeleted]);

  // ── Bulk select ──────────────────────────────────────────────────────────────
  const bulkSelect = useBulkSelect(data?.items ?? []);

  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
  }, [bulkSelect.someSelected]);

  const bulkActions = useMemo<BulkAction[]>(() => [
    {
      id: 'delete',
      label: 'Видалити вибраних',
      variant: 'destructive',
      onClick: async (ids: string[]) => {
        const results = await Promise.allSettled(
          ids.map(id => apiFetch(`/counterparties/${id}`, { method: 'DELETE' })),
        );
        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.length - succeeded;
        bulkSelect.clear();
        load();
        if (succeeded > 0 && failed === 0) {
          toast.success(`Видалено ${succeeded} контрагент${succeeded === 1 ? 'а' : 'ів'}`);
        } else if (succeeded > 0) {
          toast.warning(`Видалено ${succeeded} з ${results.length}. ${failed} не вдалось`);
        } else {
          toast.error('Не вдалося видалити контрагентів');
        }
      },
    },
  ], [bulkSelect]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Unsaved guard (modal form) ───────────────────────────────────────────────
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (debouncedSearch) params.set('q', debouncedSearch);
    if (typeFilter) params.set('type', typeFilter);
    if (showDeleted) params.set('showDeleted', 'true');
    apiFetch<Paginated>(`/counterparties?${params}`)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження'))
      .finally(() => setLoading(false));
  }, [page, debouncedSearch, typeFilter, showDeleted]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selectedCp || !detailPanel.enabled) { setCpVehicles([]); return; }
    let cancelled = false;
    setVehiclesLoading(true);
    apiFetch<{ id: string }[]>(`/counterparties/${selectedCp.id}/garages`)
      .then(garages => Promise.all(garages.map(g =>
        apiFetch<{ id: string; make: string; model: string; year: number | null; licensePlate: string }[]>(`/vehicles?customerGarageId=${g.id}&limit=50`)
      )))
      .then(results => { if (!cancelled) setCpVehicles(results.flat()); })
      .catch(() => { if (!cancelled) setCpVehicles([]); })
      .finally(() => { if (!cancelled) setVehiclesLoading(false); });
    return () => { cancelled = true; };
  }, [selectedCp?.id, detailPanel.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      setError('Некоректний email'); return;
    }
    if (form.edrpou && !/^\d{8}$/.test(form.edrpou)) {
      setError('ЄДРПОУ повинен містити рівно 8 цифр'); return;
    }
    if (form.phone && !/^\+?[\d\s\-()+]{7,20}$/.test(form.phone)) {
      setError('Некоректний номер телефону'); return;
    }
    setSaving(true); setError('');
    try {
      await apiFetch<Counterparty>('/counterparties', {
        method: 'POST',
        body: JSON.stringify({
          type: form.type,
          firstName: form.firstName || undefined,
          lastName: form.lastName || undefined,
          companyName: form.companyName || undefined,
          phone: form.phone || undefined,
          email: form.email || undefined,
          edrpou: form.edrpou || undefined,
          vatPayer: form.vatPayer || undefined,
          notes: form.notes || undefined,
          contactPerson: form.contactPerson || undefined,
        }),
      });
      dirty.resetDirty();
      setModal(false);
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const handleCloseModal = async () => {
    if (!(await dirty.confirmClose())) return;
    setModal(false);
    setEditingCp(null);
  };

  const openEdit = (cp: Counterparty) => {
    setEditTab('main');
    setEditingCp(cp);
    setForm({
      type: cp.type,
      firstName: cp.firstName ?? '',
      lastName: cp.lastName ?? '',
      companyName: cp.companyName ?? '',
      phone: cp.phone ?? '',
      email: cp.email ?? '',
      edrpou: cp.edrpou ?? '',
      vatPayer: cp.vatPayer,
      notes: '',
      contactPerson: '',
    });
    dirty.resetDirty();
    setError('');
    setModalVehicles([]);
    setModalGarageId(null);
    setShowAddVehicle(false);
    setAddVehicleForm({ make: '', model: '', year: '', licensePlate: '', vin: '' });
    setModalWorkOrders([]);
    setVehiclesError('');
    setWoError('');
    setModal(true);

    // Race-guarded parallel fetch: vehicles and work orders for this CP.
    const vReqId = ++modalVehiclesReqRef.current;
    const woReqId = ++modalWoReqRef.current;

    setModalVehiclesLoading(true);
    apiFetch<{ id: string }[]>(`/counterparties/${cp.id}/garages`)
      .then(garages => {
        if (modalVehiclesReqRef.current !== vReqId) return [] as Vehicle[][];
        const defaultGarage = garages[0];
        if (defaultGarage) setModalGarageId(defaultGarage.id);
        return Promise.all(garages.map(g =>
          apiFetch<Vehicle[]>(`/vehicles?customerGarageId=${g.id}&limit=50`)
        ));
      })
      .then(results => { if (modalVehiclesReqRef.current === vReqId) setModalVehicles(results.flat()); })
      .catch(err => { if (modalVehiclesReqRef.current === vReqId) setVehiclesError(err instanceof Error ? err.message : 'Помилка завантаження авто'); })
      .finally(() => { if (modalVehiclesReqRef.current === vReqId) setModalVehiclesLoading(false); });

    setModalWorkOrdersLoading(true);
    apiFetch<{ items: ModalWorkOrder[] }>(`/work-orders?counterpartyId=${cp.id}&limit=50`)
      .then(data => { if (modalWoReqRef.current === woReqId) setModalWorkOrders(data.items); })
      .catch(err => { if (modalWoReqRef.current === woReqId) setWoError(err instanceof Error ? err.message : 'Помилка завантаження нарядів'); })
      .finally(() => { if (modalWoReqRef.current === woReqId) setModalWorkOrdersLoading(false); });
  };

  const addVehicle = async () => {
    if (!modalGarageId || !addVehicleForm.make || !addVehicleForm.model) return;
    setAddingVehicle(true);
    try {
      const created = await apiFetch<Vehicle>('/vehicles', {
        method: 'POST',
        body: JSON.stringify({
          customerGarageId: modalGarageId,
          make: addVehicleForm.make,
          model: addVehicleForm.model,
          year: addVehicleForm.year ? Number(addVehicleForm.year) : undefined,
          licensePlate: addVehicleForm.licensePlate || undefined,
          vin: addVehicleForm.vin || undefined,
        }),
      });
      setModalVehicles(v => [...v, created]);
      setAddVehicleForm({ make: '', model: '', year: '', licensePlate: '', vin: '' });
      setShowAddVehicle(false);
      toast.success('Авто додано');
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Помилка'); }
    finally { setAddingVehicle(false); }
  };

  const deleteVehicle = async (id: string) => {
    if (!(await confirm({ title: 'Видалити авто?', variant: 'destructive' }))) return;
    setDeletingVehicleId(id);
    try {
      await apiFetch(`/vehicles/${id}`, { method: 'DELETE' });
      setModalVehicles(v => v.filter(x => x.id !== id));
      toast.success('Авто видалено');
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Помилка'); }
    finally { setDeletingVehicleId(null); }
  };

  const update = async () => {
    if (!editingCp) return;
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) { setError('Некоректний email'); return; }
    if (form.edrpou && !/^\d{8}$/.test(form.edrpou)) { setError('ЄДРПОУ повинен містити рівно 8 цифр'); return; }
    if (form.phone && !/^\+?[\d\s\-()+]{7,20}$/.test(form.phone)) { setError('Некоректний номер телефону'); return; }
    setSaving(true); setError('');
    try {
      await apiFetch(`/counterparties/${editingCp.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          firstName: form.firstName || undefined,
          lastName: form.lastName || undefined,
          companyName: form.companyName || undefined,
          phone: form.phone || undefined,
          email: form.email || undefined,
          edrpou: form.edrpou || undefined,
          vatPayer: form.vatPayer || undefined,
          notes: form.notes || undefined,
          contactPerson: form.contactPerson || undefined,
        }),
      });
      dirty.resetDirty();
      setModal(false);
      setEditingCp(null);
      if (selectedCp?.id === editingCp.id) setSelectedCp(null);
      toast.success('Контрагента збережено');
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const markDeleted = async (id: string) => {
    if (!(await confirm({ title: 'Позначити контрагента на видалення?', variant: 'destructive' }))) return;
    try {
      await apiFetch(`/counterparties/${id}`, { method: 'DELETE' });
      toast.success('Контрагента позначено на видалення');
      if (selectedCp?.id === id) setSelectedCp(null);
      load();
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : 'Помилка видалення'); }
  };

  const displayName = (cp: Counterparty) =>
    cp.companyName ?? [cp.lastName, cp.firstName].filter(Boolean).join(' ') ?? '—';

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1;

  const CRM_CONFIG_FIELD_DEFS = [
    { key: 'phone', label: 'Телефон' },
    { key: 'email', label: 'Email' },
    { key: 'edrpou', label: 'ЄДРПОУ' },
    { key: 'balance', label: 'Баланс' },
    { key: 'contactPerson', label: 'Контактна особа' },
    { key: 'type', label: 'Тип контрагента' },
  ] as const;

  const crmPanelConfigFields = CRM_CONFIG_FIELD_DEFS.map(f => ({
    ...f,
    hidden: panelConfig.isFieldHidden(f.key),
  }));

  const buildCpTabs = (cp: Counterparty): DetailPanelTab[] => [
    {
      key: 'info',
      label: 'Основне',
      content: (
        <div className="space-y-3">
          {!panelConfig.isFieldHidden('type') && (
            <div className="flex flex-wrap gap-1.5">
              <Badge variant={TYPE_BADGE[cp.type] ?? 'secondary'}>{TYPE_LABELS[cp.type]}</Badge>
              {cp.vatPayer && <Badge variant="warning">ПДВ</Badge>}
              {cp.deletedAt && <Badge variant="secondary">видалено</Badge>}
            </div>
          )}
          <PanelField label="Телефон" value={cp.phone} fieldKey="phone" hidden={panelConfig.isFieldHidden('phone')} />
          <PanelField label="Email" value={cp.email} fieldKey="email" hidden={panelConfig.isFieldHidden('email')} />
          <PanelField label="ЄДРПОУ" value={cp.edrpou} fieldKey="edrpou" hidden={panelConfig.isFieldHidden('edrpou')} />
          <PanelField
            label="Баланс"
            fieldKey="balance"
            hidden={panelConfig.isFieldHidden('balance')}
            value={
              <span className={cn('font-semibold', cp.balance < 0 ? 'text-destructive-text' : cp.balance > 0 ? 'text-success-text' : 'text-muted-foreground')}>
                {cp.balance.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
              </span>
            }
          />
        </div>
      ),
    },
    {
      key: 'vehicles',
      label: 'Авто',
      content: vehiclesLoading ? (
        <div className="flex justify-center py-6"><Spinner size="sm" /></div>
      ) : cpVehicles.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Авто не додано</p>
      ) : (
        <div className="space-y-2">
          {cpVehicles.map(v => (
            <div key={v.id} className="rounded-lg border border-border bg-surface px-3 py-2.5 text-[13px]">
              <p className="font-medium text-foreground">{v.make} {v.model}</p>
              <p className="text-muted-foreground text-[12px] mt-0.5">
                {v.year && `${v.year} · `}{v.licensePlate || 'без держномера'}
              </p>
            </div>
          ))}
        </div>
      ),
    },
  ];

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Контрагенти</h1>
          <p className="page-subtitle">
            {data ? `${data.total} записів` : 'Завантаження...'}
          </p>
        </div>
        <Button
          leftIcon={<Plus />}
          onClick={() => {
            setEditingCp(null);
            setForm({ type: 'CLIENT', firstName: '', lastName: '', companyName: '', phone: '', email: '', edrpou: '', vatPayer: false, notes: '', contactPerson: '' });
            dirty.resetDirty();
            setError(''); setModal(true);
          }}
        >
          Додати
        </Button>
      </div>

      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}

      {/* Saved filters */}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<CrmFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          className="mb-3"
          hideSaveButton
        />
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <Input
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); setActiveSavedFilterId(null); }}
          placeholder="Пошук за ім'ям, телефоном, ЄДРПОУ..."
          leftElement={<Search />}
          className="flex-1 min-w-48"
        />
        <Select
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setPage(1); setActiveSavedFilterId(null); }}
          className="w-44"
        >
          {TYPE_FILTER_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        <Button
          variant="outline"
          size="md"
          leftIcon={showDeleted ? <Eye /> : <EyeOff />}
          onClick={() => { setShowDeleted(d => !d); setPage(1); setActiveSavedFilterId(null); }}
          className={showDeleted ? 'border-primary text-primary' : ''}
        >
          {showDeleted ? 'Сховати видалені' : 'Показати видалені'}
        </Button>
        <div className="flex items-center gap-2 ml-auto">
          <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
          {features.savedFiltersEnabled && (
            <SaveFilterButton onSave={handleSaveFilter} />
          )}
          <ColumnsDropdown
                  columns={orderedColumns}
                  visibleKeys={colVisible}
                  onToggle={toggleCol}
                  onReorder={reorder}
                  onRename={renameColumn}
                  onReset={resetConfig}
                  hasCustomization={JSON.stringify(order) !== JSON.stringify(CRM_COLUMNS.map(c => c.key)) || Object.keys(customLabels).length > 0}
                />
        </div>
      </div>

      {/* Bulk actions */}
      {features.bulkActionsEnabled && bulkSelect.count > 0 && (
        <BulkActionsBar
          count={bulkSelect.count}
          selectedIds={Array.from(bulkSelect.selected)}
          actions={bulkActions}
          onClear={bulkSelect.clear}
          className="mb-3"
        />
      )}

      {/* Table + DetailPanel */}
      <div className="flex gap-0 flex-1 min-h-0">
        <div className="flex-1 min-w-0 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {features.bulkActionsEnabled && (
                  <TableHead className="w-9 pr-0">
                    <input
                      type="checkbox"
                      checked={bulkSelect.allSelected}
                      ref={selectAllRef}
                      onChange={bulkSelect.toggleAll}
                      className="h-3.5 w-3.5 rounded border-border"
                      aria-label="Вибрати всіх"
                    />
                  </TableHead>
                )}
                {visibleColumns.map(col => <TableHead key={col.key} {...dragProps(col.key)}>{col.label}</TableHead>)}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)} className="py-12 text-center">
                    <div className="flex justify-center"><Spinner size="md" /></div>
                  </TableCell>
                </TableRow>
              )}
              {!loading && data?.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)} className="p-0">
                    <EmptyState icon={Users} title="Нічого не знайдено" description="Спробуйте змінити параметри пошуку" size="sm" />
                  </TableCell>
                </TableRow>
              )}
              {!loading && data?.items.map(cp => {
                const isDeleted = !!cp.deletedAt;
                return (
                  <TableRow
                    key={cp.id}
                    className={cn(
                      'transition-colors',
                      detailPanel.enabled && 'cursor-pointer',
                      isDeleted && 'opacity-60',
                      selectedCp?.id === cp.id && 'bg-secondary',
                      bulkSelect.isSelected(cp.id) && 'bg-primary/5',
                    )}
                    onClick={() => { if (detailPanel.enabled) setSelectedCp(prev => prev?.id === cp.id ? null : cp); }}
                  >
                    {features.bulkActionsEnabled && (
                      <TableCell className="w-9 pr-0" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={bulkSelect.isSelected(cp.id)}
                          onChange={() => bulkSelect.toggle(cp.id)}
                          className="h-3.5 w-3.5 rounded border-border"
                          aria-label={`Вибрати ${displayName(cp)}`}
                        />
                      </TableCell>
                    )}
                    {visibleColumns.map(col => {
                      if (col.key === 'name') return (
                        <TableCell key="name">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-[13px] font-medium text-primary">{displayName(cp)}</p>
                            {isDeleted && <Badge variant="secondary">видалено</Badge>}
                          </div>
                          {cp.email && <p className="text-[12px] text-muted-foreground mt-0.5">{cp.email}</p>}
                        </TableCell>
                      );
                      if (col.key === 'type') return (
                        <TableCell key="type">
                          <Badge variant={TYPE_BADGE[cp.type] ?? 'secondary'}>{TYPE_LABELS[cp.type]}</Badge>
                        </TableCell>
                      );
                      if (col.key === 'phone') return <TableCell key="phone" className="text-muted-foreground text-[13px]">{cp.phone ?? '—'}</TableCell>;
                      if (col.key === 'edrpou') return <TableCell key="edrpou" className="text-muted-foreground text-[13px]">{cp.edrpou ?? '—'}</TableCell>;
                      if (col.key === 'balance') return (
                        <TableCell key="balance" className={cn('font-semibold tabular-nums text-[13px]', cp.balance < 0 ? 'text-destructive-text' : cp.balance > 0 ? 'text-success-text' : 'text-muted-foreground')}>
                          {cp.balance.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
                        </TableCell>
                      );
                      return null;
                    })}
                    <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        {!isDeleted && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Редагувати"
                            onClick={() => openEdit(cp)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {!isDeleted && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                            title="Позначити на видалення"
                            onClick={() => markDeleted(cp.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-center gap-1.5 mt-4 pb-4">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={cn(
                    'h-8 w-8 rounded-lg text-[13px] font-medium border transition-colors',
                    p === page
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border text-muted-foreground bg-surface hover:bg-secondary',
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>

        <DetailPanel
          open={!!selectedCp && detailPanel.enabled}
          onClose={() => setSelectedCp(null)}
          title={selectedCp ? displayName(selectedCp) : ''}
          tabs={selectedCp ? buildCpTabs(selectedCp) : undefined}
          configFields={crmPanelConfigFields}
          onToggleField={panelConfig.toggleField}
          onReset={panelConfig.reset}
        />
      </div>

      {/* Create / Edit modal */}
      <Modal
        open={modal}
        onClose={handleCloseModal}
        title={editingCp ? 'Редагування контрагента' : 'Новий контрагент'}
        size={editingCp ? 'lg' : 'md'}
        footer={
          editTab === 'main'
            ? <Button onClick={editingCp ? update : create} loading={saving}>{editingCp ? 'Оновити' : 'Зберегти'}</Button>
            : null
        }
      >
        {/* Tab bar — тільки при редагуванні */}
        {editingCp && (
          <div className="flex gap-0 border-b border-border -mx-6 px-6 mb-5 overflow-x-auto">
            {(
              [
                { key: 'main', label: 'Основне' },
                { key: 'vehicles', label: 'Авто', count: modalVehicles.length },
                { key: 'work-orders', label: 'Історія', count: modalWorkOrders.length },
              ] as { key: typeof editTab; label: string; count?: number }[]
            ).map(tab => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setEditTab(tab.key)}
                className={cn(
                  'flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0',
                  editTab === tab.key
                    ? 'text-primary border-primary'
                    : 'text-muted-foreground border-transparent hover:text-foreground',
                )}
              >
                {tab.label}
                {tab.count !== undefined && (
                  <span className={cn(
                    'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-semibold',
                    editTab === tab.key ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground',
                  )}>
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* ── Вкладка: Основне (або єдина форма при створенні) ── */}
        {(!editingCp || editTab === 'main') && (
          <div key="tab-main" className="animate-in fade-in duration-150">
            {error && (
              <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
                {error}
              </div>
            )}
            <div className="space-y-4">
              <Select label="Тип" required value={form.type}
                onChange={e => { setForm(f => ({ ...f, type: e.target.value })); dirty.markDirty(); }}>
                {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>

              {form.type !== 'SUPPLIER' && (
                <div className="grid grid-cols-2 gap-3">
                  <Input label="Ім'я" value={form.firstName}
                    onChange={e => { setForm(f => ({ ...f, firstName: e.target.value })); dirty.markDirty(); }}
                    placeholder="Іван" />
                  <Input label="Прізвище" value={form.lastName}
                    onChange={e => { setForm(f => ({ ...f, lastName: e.target.value })); dirty.markDirty(); }}
                    placeholder="Коваль" />
                </div>
              )}

              <Input label="Назва компанії" value={form.companyName}
                onChange={e => { setForm(f => ({ ...f, companyName: e.target.value })); dirty.markDirty(); }}
                placeholder="ТОВ «Авто»" />

              <Input label="Телефон" value={form.phone}
                onChange={e => { setForm(f => ({ ...f, phone: e.target.value })); dirty.markDirty(); }}
                placeholder="+38 (067) 123-45-67" />

              <Input label="Email" type="email" value={form.email}
                onChange={e => { setForm(f => ({ ...f, email: e.target.value })); dirty.markDirty(); }} />

              <Input label="ЄДРПОУ" value={form.edrpou}
                onChange={e => { setForm(f => ({ ...f, edrpou: e.target.value })); dirty.markDirty(); }}
                placeholder="12345678" />

              <Input label="Контактна особа" value={form.contactPerson}
                onChange={e => { setForm(f => ({ ...f, contactPerson: e.target.value })); dirty.markDirty(); }}
                placeholder="Петро Іваненко" />

              <Input label="Нотатки" value={form.notes}
                onChange={e => { setForm(f => ({ ...f, notes: e.target.value })); dirty.markDirty(); }} />

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={form.vatPayer}
                  onChange={e => { setForm(f => ({ ...f, vatPayer: e.target.checked })); dirty.markDirty(); }}
                  className="h-4 w-4 rounded border-border accent-primary" />
                <span className="text-sm text-foreground">Платник ПДВ</span>
              </label>
            </div>
          </div>
        )}

        {/* ── Вкладка: Авто ── */}
        {editingCp && editTab === 'vehicles' && (
          <div key="tab-vehicles" className="space-y-3 animate-in fade-in duration-150">
            {modalVehiclesLoading && (
              <div className="py-8 text-center text-sm text-muted-foreground">Завантаження...</div>
            )}
            {!modalVehiclesLoading && vehiclesError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
                {vehiclesError}
              </div>
            )}
            {!modalVehiclesLoading && !vehiclesError && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-muted-foreground">{modalVehicles.length} авто</span>
                  {!showAddVehicle && (
                    <Button size="sm" variant="outline" leftIcon={<Plus className="h-3.5 w-3.5" />}
                      onClick={() => setShowAddVehicle(true)}>
                      Додати авто
                    </Button>
                  )}
                </div>
                {showAddVehicle && (
                  <AnimatedBody className="rounded-lg border border-border bg-secondary/40 p-3 space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <Input label="Марка" required value={addVehicleForm.make}
                        onChange={e => setAddVehicleForm(f => ({ ...f, make: e.target.value }))} placeholder="Toyota" />
                      <Input label="Модель" required value={addVehicleForm.model}
                        onChange={e => setAddVehicleForm(f => ({ ...f, model: e.target.value }))} placeholder="Camry" />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <Input label="Рік" type="number" value={addVehicleForm.year}
                        onChange={e => setAddVehicleForm(f => ({ ...f, year: e.target.value }))} placeholder="2020" />
                      <Input label="Держномер" value={addVehicleForm.licensePlate}
                        onChange={e => setAddVehicleForm(f => ({ ...f, licensePlate: e.target.value }))} placeholder="АА 1234 ВС" />
                      <Input label="VIN" value={addVehicleForm.vin}
                        onChange={e => setAddVehicleForm(f => ({ ...f, vin: e.target.value }))} placeholder="WVWZZZ1JZXW000001" />
                    </div>
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" variant="outline"
                        onClick={() => { setShowAddVehicle(false); setAddVehicleForm({ make: '', model: '', year: '', licensePlate: '', vin: '' }); }}>
                        Скасувати
                      </Button>
                      <Button size="sm" onClick={addVehicle} loading={addingVehicle}
                        disabled={!addVehicleForm.make || !addVehicleForm.model}>
                        Зберегти
                      </Button>
                    </div>
                  </AnimatedBody>
                )}
                {modalVehicles.length > 0 && (
                  <div className="rounded-xl border border-border overflow-hidden">
                    <table className="w-full text-[13px]">
                      <thead className="bg-secondary border-b border-border">
                        <tr>
                          <th className="text-left px-3 py-2 text-muted-foreground font-medium">Марка / Модель</th>
                          <th className="text-left px-3 py-2 text-muted-foreground font-medium">Держномер</th>
                          <th className="text-left px-3 py-2 text-muted-foreground font-medium">Рік</th>
                          <th className="w-16" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {modalVehicles.map(v => (
                          <tr key={v.id} className="bg-surface hover:bg-secondary/50 transition-colors">
                            <td className="px-3 py-2 font-medium text-foreground">{v.make} {v.model}</td>
                            <td className="px-3 py-2 text-muted-foreground">{v.licensePlate || '—'}</td>
                            <td className="px-3 py-2 text-muted-foreground">{v.year ?? '—'}</td>
                            <td className="px-3 py-2">
                              <button type="button" onClick={() => deleteVehicle(v.id)}
                                disabled={deletingVehicleId === v.id}
                                className="text-destructive/70 hover:text-destructive hover:bg-destructive/10 p-1 rounded transition-colors"
                                title="Видалити">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {modalVehicles.length === 0 && !showAddVehicle && (
                  <p className="text-[13px] text-muted-foreground text-center py-8">Авто не додано</p>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Вкладка: Історія нарядів ── */}
        {editingCp && editTab === 'work-orders' && (
          <div key="tab-work-orders" className="space-y-3 animate-in fade-in duration-150">
            {modalWorkOrdersLoading && (
              <div className="py-8 text-center text-sm text-muted-foreground">Завантаження...</div>
            )}
            {!modalWorkOrdersLoading && woError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
                {woError}
              </div>
            )}
            {!modalWorkOrdersLoading && !woError && modalWorkOrders.length === 0 && (
              <p className="text-[13px] text-muted-foreground text-center py-8">Нарядів немає</p>
            )}
            {!modalWorkOrdersLoading && !woError && modalWorkOrders.length > 0 && (
              <div className="rounded-xl border border-border overflow-hidden">
                <table className="w-full text-[13px]">
                  <thead className="bg-secondary border-b border-border">
                    <tr>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Номер</th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Авто</th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Статус</th>
                      <th className="text-right px-3 py-2 text-muted-foreground font-medium">Сума</th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Дата</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {modalWorkOrders.map(wo => (
                      <tr key={wo.id}
                        className="bg-surface hover:bg-secondary/50 transition-colors cursor-pointer"
                        onClick={() => router.push(`/work-orders/${wo.id}`)}>
                        <td className="px-3 py-2 font-mono font-medium text-foreground">{wo.number}</td>
                        <td className="px-3 py-2 text-muted-foreground">{wo.vehicleSummary || '—'}</td>
                        <td className="px-3 py-2">
                          <Badge variant={WO_STATUS_BADGE[wo.status] ?? 'secondary'} dot>
                            {WO_STATUS_LABELS[wo.status] ?? wo.status}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-right text-foreground tabular-nums">
                          {wo.totalAmount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {new Date(wo.createdAt).toLocaleDateString('uk-UA')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>
      <DirtyConfirmDialog {...dirty.dialogProps} />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
