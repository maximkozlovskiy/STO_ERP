'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { useRouter } from 'next/navigation';
import { Plus, Search, Users, Eye, EyeOff, Trash2, Pencil } from 'lucide-react';
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
import { DetailPanel, PanelField, PanelSection, type DetailPanelTab } from '@/components/ui/detail-panel';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import { SavedFiltersBar } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { useDetailPanel } from '@/hooks/useDetailPanel';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useTableColumns } from '@/hooks/useTableColumns';
import { useDirtyForm } from '@/hooks/useDirtyForm';
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

  // ── Vehicles for selected counterparty ──────────────────────────────────────
  const [cpVehicles, setCpVehicles] = useState<{ id: string; make: string; model: string; year: number | null; licensePlate: string }[]>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);

  // ── Column visibility ────────────────────────────────────────────────────────
  const CRM_COLUMNS = useMemo(() => [
    { key: 'name',    label: 'Контрагент',  defaultVisible: true },
    { key: 'type',    label: 'Тип',         defaultVisible: true },
    { key: 'phone',   label: 'Телефон',     defaultVisible: true },
    { key: 'edrpou',  label: 'ЄДРПОУ',     defaultVisible: false },
    { key: 'balance', label: 'Баланс, ₴',  defaultVisible: true },
  ], []);

  const { visibleKeys: colVisible, visibleColumns, orderedColumns, order, customLabels, toggle: toggleCol, reorder, renameColumn, resetConfig } = useTableColumns('crm', CRM_COLUMNS);

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
    setVehiclesLoading(true);
    apiFetch<{ id: string }[]>(`/counterparties/${selectedCp.id}/garages`)
      .then(garages => Promise.all(garages.map(g =>
        apiFetch<{ id: string; make: string; model: string; year: number | null; licensePlate: string }[]>(`/vehicles?customerGarageId=${g.id}&limit=50`)
      )))
      .then(results => setCpVehicles(results.flat()))
      .catch(() => setCpVehicles([]))
      .finally(() => setVehiclesLoading(false));
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
    if (!dirty.confirmClose()) return;
    setModal(false);
    setEditingCp(null);
  };

  const openEdit = (cp: Counterparty) => {
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
    setModal(true);
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

  const buildCpTabs = (cp: Counterparty): DetailPanelTab[] => [
    {
      key: 'info',
      label: 'Основне',
      content: (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            <Badge variant={TYPE_BADGE[cp.type] ?? 'secondary'}>{TYPE_LABELS[cp.type]}</Badge>
            {cp.vatPayer && <Badge variant="warning">ПДВ</Badge>}
            {cp.deletedAt && <Badge variant="secondary">видалено</Badge>}
          </div>
          <PanelField label="Телефон" value={cp.phone} />
          <PanelField label="Email" value={cp.email} />
          <PanelField label="ЄДРПОУ" value={cp.edrpou} />
          <PanelField label="Баланс" value={
            <span className={cn('font-semibold', cp.balance < 0 ? 'text-destructive-text' : cp.balance > 0 ? 'text-success-text' : 'text-muted-foreground')}>
              {cp.balance.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
            </span>
          } />
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
                {visibleColumns.map(col => <TableHead key={col.key}>{col.label}</TableHead>)}
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
        />
      </div>

      {/* Create / Edit modal */}
      <Modal
        open={modal}
        onClose={handleCloseModal}
        title={editingCp ? 'Редагування контрагента' : 'Новий контрагент'}
        footer={
          <Button onClick={editingCp ? update : create} loading={saving}>
            {editingCp ? 'Оновити' : 'Зберегти'}
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <div className="space-y-4">
          <Select
            label="Тип"
            required
            value={form.type}
            onChange={e => { setForm(f => ({ ...f, type: e.target.value })); dirty.markDirty(); }}
          >
            {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>

          {form.type !== 'SUPPLIER' && (
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Ім'я"
                value={form.firstName}
                onChange={e => { setForm(f => ({ ...f, firstName: e.target.value })); dirty.markDirty(); }}
                placeholder="Іван"
              />
              <Input
                label="Прізвище"
                value={form.lastName}
                onChange={e => { setForm(f => ({ ...f, lastName: e.target.value })); dirty.markDirty(); }}
                placeholder="Коваль"
              />
            </div>
          )}

          <Input
            label="Назва компанії"
            value={form.companyName}
            onChange={e => { setForm(f => ({ ...f, companyName: e.target.value })); dirty.markDirty(); }}
            placeholder="ТОВ «Авто»"
          />

          <Input
            label="Телефон"
            value={form.phone}
            onChange={e => { setForm(f => ({ ...f, phone: e.target.value })); dirty.markDirty(); }}
            placeholder="+38 (067) 123-45-67"
          />

          <Input
            label="Email"
            type="email"
            value={form.email}
            onChange={e => { setForm(f => ({ ...f, email: e.target.value })); dirty.markDirty(); }}
          />

          <Input
            label="ЄДРПОУ"
            value={form.edrpou}
            onChange={e => { setForm(f => ({ ...f, edrpou: e.target.value })); dirty.markDirty(); }}
            placeholder="12345678"
          />

          <Input
            label="Контактна особа"
            value={form.contactPerson}
            onChange={e => { setForm(f => ({ ...f, contactPerson: e.target.value })); dirty.markDirty(); }}
            placeholder="Петро Іваненко"
          />

          <Input
            label="Нотатки"
            value={form.notes}
            onChange={e => { setForm(f => ({ ...f, notes: e.target.value })); dirty.markDirty(); }}
          />

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.vatPayer}
              onChange={e => { setForm(f => ({ ...f, vatPayer: e.target.checked })); dirty.markDirty(); }}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            <span className="text-sm text-foreground">Платник ПДВ</span>
          </label>
        </div>
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
