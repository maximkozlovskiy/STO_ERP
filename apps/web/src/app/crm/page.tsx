'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { useRouter } from 'next/navigation';
import { Plus, Search, Users, Eye, EyeOff, Trash2 } from 'lucide-react';
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
import { SavedFiltersBar } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [selectedCp, setSelectedCp] = useState<Counterparty | null>(null);
  const [form, setForm] = useState({
    type: 'CLIENT', firstName: '', lastName: '', companyName: '', phone: '', email: '', edrpou: '',
    vatPayer: false, notes: '', contactPerson: '',
  });

  const features = useUiFeatures();
  const { confirm, dialogProps } = useConfirm();

  // ── Column visibility ────────────────────────────────────────────────────────
  const CRM_COLUMNS = useMemo(() => [
    { key: 'name',    label: 'Контрагент',  defaultVisible: true },
    { key: 'type',    label: 'Тип',         defaultVisible: true },
    { key: 'phone',   label: 'Телефон',     defaultVisible: true },
    { key: 'edrpou',  label: 'ЄДРПОУ',     defaultVisible: false },
    { key: 'balance', label: 'Баланс, ₴',  defaultVisible: true },
  ], []);

  const { visibleKeys: colVisible, toggle: toggleCol } = useTableColumns('crm', CRM_COLUMNS);

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
        <ColumnsDropdown
          columns={CRM_COLUMNS}
          visibleKeys={colVisible}
          onToggle={toggleCol}
          className="ml-auto"
        />
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
                {colVisible.has('name')    && <TableHead>Контрагент</TableHead>}
                {colVisible.has('type')    && <TableHead>Тип</TableHead>}
                {colVisible.has('phone')   && <TableHead>Телефон</TableHead>}
                {colVisible.has('edrpou')  && <TableHead>ЄДРПОУ</TableHead>}
                {colVisible.has('balance') && <TableHead>Баланс, ₴</TableHead>}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={colVisible.size + (features.bulkActionsEnabled ? 2 : 1)} className="py-12 text-center">
                    <div className="flex justify-center"><Spinner size="md" /></div>
                  </TableCell>
                </TableRow>
              )}
              {!loading && data?.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={colVisible.size + (features.bulkActionsEnabled ? 2 : 1)} className="p-0">
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
                      'cursor-pointer',
                      isDeleted && 'opacity-60',
                      selectedCp?.id === cp.id && 'bg-secondary',
                      bulkSelect.isSelected(cp.id) && 'bg-primary/5',
                    )}
                    onClick={() => setSelectedCp(prev => prev?.id === cp.id ? null : cp)}
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
                    {colVisible.has('name') && (
                      <TableCell>
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-[13px] font-medium text-primary">{displayName(cp)}</p>
                          {isDeleted && <Badge variant="secondary">видалено</Badge>}
                        </div>
                        {cp.email && <p className="text-[12px] text-muted-foreground mt-0.5">{cp.email}</p>}
                      </TableCell>
                    )}
                    {colVisible.has('type') && (
                      <TableCell>
                        <Badge variant={TYPE_BADGE[cp.type] ?? 'secondary'}>
                          {TYPE_LABELS[cp.type]}
                        </Badge>
                      </TableCell>
                    )}
                    {colVisible.has('phone') && (
                      <TableCell className="text-muted-foreground text-[13px]">{cp.phone ?? '—'}</TableCell>
                    )}
                    {colVisible.has('edrpou') && (
                      <TableCell className="text-muted-foreground text-[13px]">{cp.edrpou ?? '—'}</TableCell>
                    )}
                    {colVisible.has('balance') && (
                      <TableCell className={cn(
                        'font-semibold tabular-nums text-[13px]',
                        cp.balance < 0 ? 'text-destructive-text' : cp.balance > 0 ? 'text-success-text' : 'text-muted-foreground',
                      )}>
                        {cp.balance.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
                      </TableCell>
                    )}
                    <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                      {!isDeleted && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          title="Позначити на видалення"
                          onClick={() => markDeleted(cp.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
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
          open={!!selectedCp}
          onClose={() => setSelectedCp(null)}
          title={selectedCp ? displayName(selectedCp) : ''}
        >
          {selectedCp && (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant={TYPE_BADGE[selectedCp.type] ?? 'secondary'}>
                    {TYPE_LABELS[selectedCp.type]}
                  </Badge>
                  {selectedCp.vatPayer && <Badge variant="warning">ПДВ</Badge>}
                  {selectedCp.deletedAt && <Badge variant="secondary">видалено</Badge>}
                </div>

                {selectedCp.phone && (
                  <div>
                    <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Телефон</p>
                    <p className="text-[13px] text-foreground">{selectedCp.phone}</p>
                  </div>
                )}

                {selectedCp.email && (
                  <div>
                    <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Email</p>
                    <p className="text-[13px] text-foreground">{selectedCp.email}</p>
                  </div>
                )}

                {selectedCp.edrpou && (
                  <div>
                    <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">ЄДРПОУ</p>
                    <p className="text-[13px] text-foreground">{selectedCp.edrpou}</p>
                  </div>
                )}

                <div>
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Баланс</p>
                  <p className={cn(
                    'text-[14px] font-semibold tabular-nums',
                    selectedCp.balance < 0 ? 'text-destructive-text' : selectedCp.balance > 0 ? 'text-success-text' : 'text-muted-foreground',
                  )}>
                    {selectedCp.balance.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
                  </p>
                </div>
              </div>

              <div className="pt-2 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => router.push(`/crm/${selectedCp.id}`)}
                >
                  Відкрити картку
                </Button>
              </div>
            </div>
          )}
        </DetailPanel>
      </div>

      {/* Create modal */}
      <Modal
        open={modal}
        onClose={handleCloseModal}
        title="Новий контрагент"
        footer={
          <Button onClick={create} loading={saving}>Зберегти</Button>
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
