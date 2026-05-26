'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, ClipboardList, Eye, EyeOff, Search, User } from 'lucide-react';
import { useRequireAuth, useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { DetailPanel } from '@/components/ui/detail-panel';
import { SavedFiltersBar } from '@/components/ui/saved-filters-bar';
import { InlineEditCell, InlineViewCell } from '@/components/ui/inline-edit-cell';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { useInlineEdit } from '@/hooks/useInlineEdit';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useTableColumns } from '@/hooks/useTableColumns';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface WorkOrder {
  id: string; number: string; status: string;
  vehicleSummary?: string; counterpartyName?: string; branchName?: string;
  totalAmount: number; plannedAt?: string | null; createdAt: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  repairCategory?: 'MAINTENANCE' | 'CURRENT_REPAIR' | 'MAJOR_REPAIR' | 'BODY_REPAIR' | 'DIAGNOSTICS' | 'WARRANTY' | 'SEASONAL' | null;
  dueDate?: string | null;
}
interface Paginated { items: WorkOrder[]; total: number; page: number; limit: number; }
interface Branch { id: string; name: string; }
interface Vehicle { id: string; make: string; model: string; licensePlate: string | null; }
interface Counterparty { id: string; firstName: string | null; lastName: string | null; companyName: string | null; }
interface WOTemplate { id: string; name: string; }

interface WOFilters extends Record<string, unknown> {
  statusFilter: string;
  categoryFilter: string;
  search: string;
  showDeleted: boolean;
  myOrders: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка', ESTIMATE: 'Кошторис', APPROVED: 'Затверджено',
  IN_PROGRESS: 'В роботі', ON_HOLD: 'Призупинено', COMPLETED: 'Виконано',
  INVOICED: 'Виставлено', PAID: 'Оплачено', ARCHIVED: 'Архів', CANCELLED: 'Скасовано',
};

const STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary', ESTIMATE: 'warning', APPROVED: 'default',
  IN_PROGRESS: 'default', ON_HOLD: 'warning', COMPLETED: 'success',
  INVOICED: 'default', PAID: 'success', ARCHIVED: 'secondary', CANCELLED: 'destructive',
};

const PRIORITY_LABELS: Record<string, string> = {
  LOW: 'Низький', NORMAL: 'Звичайний', HIGH: 'Високий', URGENT: 'Терміново',
};

const PRIORITY_BADGE: Record<string, BadgeVariant> = {
  LOW: 'secondary', NORMAL: 'default', HIGH: 'warning', URGENT: 'destructive',
};

const CATEGORY_LABELS: Record<string, string> = {
  MAINTENANCE: 'ТО',
  CURRENT_REPAIR: 'Поточний ремонт',
  MAJOR_REPAIR: 'Кап. ремонт',
  BODY_REPAIR: 'Кузовний',
  DIAGNOSTICS: 'Діагностика',
  WARRANTY: 'Гарантійний',
  SEASONAL: 'Сезонне',
};

const STATUS_TABS: Array<[string, string]> = [
  ['', 'Всі'],
  ['IN_PROGRESS', 'В роботі'],
  ['APPROVED', 'Затверджено'],
  ['ESTIMATE', 'Кошторис'],
  ['DRAFT', 'Чернетка'],
  ['COMPLETED', 'Виконано'],
  ['INVOICED', 'Виставлено'],
  ['PAID', 'Оплачено'],
  ['ON_HOLD', 'Призупинено'],
  ['CANCELLED', 'Скасовано'],
  ['ARCHIVED', 'Архів'],
];

function formatDate(iso: string): string {
  const d = new Date(iso);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

function isOverdue(dueDateIso: string, nowMs: number): boolean {
  const due = new Date(dueDateIso);
  due.setHours(23, 59, 59, 999);
  return due.getTime() < nowMs;
}

export default function WorkOrdersPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT']);
  const { employee } = useAuth();
  const router = useRouter();

  const [nowMs, setNowMs] = useState(0);
  useEffect(() => { setNowMs(Date.now()); }, []);

  const [data, setData] = useState<Paginated | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');

  const [search, setSearch] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  // Default to "my orders" for MECHANICs — initialized lazily after employee loads
  const [myOrders, setMyOrders] = useState(false);
  const myOrdersInitRef = useRef(false);
  const [selectedWO, setSelectedWO] = useState<WorkOrder | null>(null);

  // Auto-activate "my orders" chip once for MECHANIC role (run only once after employee loads).
  // Must be declared AFTER the `myOrdersInitRef` and `setMyOrders` it references, otherwise TDZ
  // ReferenceError fires on first render.
  useEffect(() => {
    if (employee && !myOrdersInitRef.current) {
      myOrdersInitRef.current = true;
      if (employee.role === 'MECHANIC') setMyOrders(true);
    }
  }, [employee]);

  const [branches, setBranches] = useState<Branch[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [templates, setTemplates] = useState<WOTemplate[]>([]);

  const features = useUiFeatures();

  const WO_COLUMNS = useMemo(() => [
    { key: 'number',    label: 'Номер' },
    { key: 'client',    label: 'Клієнт / Авто' },
    { key: 'status',    label: 'Статус' },
    { key: 'priority',  label: 'Пріоритет' },
    { key: 'amount',    label: 'Сума, ₴' },
    { key: 'plannedAt', label: 'Заплановано' },
    { key: 'dueDate',   label: 'Дедлайн' },
  ], []);

  const { visibleKeys: colVisible, toggle: toggleCol } = useTableColumns('work-orders', WO_COLUMNS);

  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const { saved: savedFilters, save: saveFilter, remove: removeFilter } = useSavedFilters<WOFilters>('work-orders');

  const applyFilter = useCallback((preset: { id: string; filters: WOFilters }) => {
    setStatusFilter(preset.filters.statusFilter ?? '');
    setCategoryFilter(preset.filters.categoryFilter ?? '');
    setSearch(preset.filters.search ?? '');
    setShowDeleted(preset.filters.showDeleted ?? false);
    setMyOrders(preset.filters.myOrders ?? false);
    setPage(1);
    setActiveSavedFilterId(preset.id);
  }, []);

  const handleSaveFilter = useCallback((name: string) => {
    const preset = saveFilter(name, { statusFilter, categoryFilter, search, showDeleted, myOrders });
    setActiveSavedFilterId(preset.id);
    if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
  }, [saveFilter, statusFilter, categoryFilter, search, showDeleted, myOrders, features.toastEnabled]);

  const bulkSelect = useBulkSelect(data?.items ?? []);

  // Sync indeterminate state on the "select-all" checkbox.
  // DOM property `indeterminate` is not exposed via the React `checked` prop,
  // so we set it imperatively whenever `someSelected` changes.
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
  }, [bulkSelect.someSelected]);

  const inlineEdit = useInlineEdit({
    enabled: features.inlineEditEnabled,
    onSave: async (rowId, field, value) => {
      try {
        await apiFetch(`/work-orders/${rowId}`, {
          method: 'PATCH',
          body: JSON.stringify({ [field]: value === '' ? null : value }),
        });
        if (features.toastEnabled) toast.success('Збережено');
        load();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Помилка збереження';
        if (features.toastEnabled) toast.error(msg);
        else setError(msg);
        throw e; // bubble so useInlineEdit keeps editing state for retry
      }
    },
  });
  const [form, setForm] = useState({
    branchId: '', vehicleId: '', counterpartyId: '',
    description: '', inMileage: '', plannedAt: '',
    priority: 'NORMAL', repairCategory: '', dueDate: '',
  });

  useEffect(() => {
    apiFetch<Branch[]>('/branches').then(bs => {
      setBranches(bs);
      // Auto-select single branch but preserve user's manual pick (race-safe on remount).
      if (bs.length === 1) setForm(f => (f.branchId ? f : { ...f, branchId: bs[0].id }));
    }).catch((e: unknown) => setFormError(e instanceof Error ? e.message : 'Не вдалося завантажити філії'));
    apiFetch<{ items: Counterparty[] }>('/counterparties?limit=200')
      .then(r => setCounterparties(r.items))
      .catch((e: unknown) => setFormError(e instanceof Error ? e.message : 'Не вдалося завантажити контрагентів'));
    apiFetch<{ items: WOTemplate[] }>('/work-order-templates?limit=100')
      .then(r => setTemplates(r.items))
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), limit: '20' });
    if (statusFilter) p.set('status', statusFilter);
    if (categoryFilter) p.set('repairCategory', categoryFilter);
    if (search) p.set('q', search);
    if (showDeleted) p.set('showDeleted', 'true');
    if (myOrders && employee?.id) p.set('employeeId', employee.id);
    apiFetch<Paginated>(`/work-orders?${p}`)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження'))
      .finally(() => setLoading(false));
  }, [page, statusFilter, categoryFilter, search, showDeleted, myOrders, employee?.id]);

  useEffect(() => { load(); }, [load]);

  // Bulk transition helper:
  //   - Uses Promise.allSettled so a single FSM-invalid transition doesn't
  //     abort the whole batch (e.g. ARCHIVE works only from PAID — the rest
  //     would otherwise leave the UI with stale selection + no feedback).
  //   - Always clears the selection and reloads, regardless of partial errors.
  //   - Aggregates the result into one toast: "Скасовано 3, не вдалось 2".
  const bulkTransition = useCallback(
    async (ids: string[], status: 'CANCELLED' | 'ARCHIVED', successLabel: string) => {
      const results = await Promise.allSettled(
        ids.map(id => apiFetch(`/work-orders/${id}/transition`, {
          method: 'POST',
          body: JSON.stringify({ status }),
        })),
      );
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed    = results.length - succeeded;

      bulkSelect.clear();
      load();

      if (features.toastEnabled) {
        if (succeeded > 0 && failed === 0) {
          toast.success(`${successLabel} ${succeeded} ${succeeded === 1 ? 'наряд' : 'нарядів'}`);
        } else if (succeeded > 0 && failed > 0) {
          toast.warning(`${successLabel} ${succeeded} з ${results.length}. ${failed} не змінено (статус не дозволяє)`);
        } else {
          // 0 succeeded — surface first error message if any
          const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
          const errMsg = firstError?.reason instanceof Error
            ? firstError.reason.message
            : 'жоден наряд не змінено (статус не дозволяє)';
          toast.error(errMsg);
        }
      } else if (failed > 0) {
        setError(`${succeeded} з ${results.length} нарядів змінено, ${failed} не вдалось`);
      }
    },
    [bulkSelect, features.toastEnabled, load],
  );

  const bulkCancel  = useCallback((ids: string[]) => bulkTransition(ids, 'CANCELLED', 'Скасовано'), [bulkTransition]);
  const bulkArchive = useCallback((ids: string[]) => bulkTransition(ids, 'ARCHIVED',  'Архівовано'), [bulkTransition]);

  const bulkActions = useMemo<BulkAction[]>(() => [
    { id: 'cancel', label: 'Скасувати', variant: 'destructive', onClick: bulkCancel },
    { id: 'archive', label: 'Архівувати', variant: 'outline', onClick: bulkArchive },
  ], [bulkCancel, bulkArchive]);

  // Track the most recent vehicle-fetch request so a stale response
  // can't overwrite vehicles/auto-selected vehicleId for the *current* counterparty.
  // Without this guard, switching counterparties faster than the network
  // would let the older fetch's `length === 1` branch hijack the form state.
  const vehicleReqRef = useRef(0);
  const loadVehicles = (counterpartyId: string) => {
    if (!counterpartyId) return;
    const reqId = ++vehicleReqRef.current;
    apiFetch<Array<{ id: string }>>(`/counterparties/${counterpartyId}/garages`)
      .then(garages => {
        const garagesArr = Array.isArray(garages) ? garages : [];
        return Promise.all(
          garagesArr.map(g =>
            apiFetch<Vehicle[]>(`/vehicles?customerGarageId=${g.id}`).catch(() => [] as Vehicle[])
          ),
        );
      })
      .then(results => {
        if (reqId !== vehicleReqRef.current) return; // stale response — ignore
        const allVehicles = results.flat();
        setVehicles(allVehicles);
        // Preserve manual pick (consistent with branchId/warehouseId auto-select
        // patrons added in 83921d2). The counterparty <Select> already clears
        // vehicleId via `setForm(f => ({ ...f, counterpartyId, vehicleId: '' }))`
        // when the user switches counterparty, so this guard only protects
        // a freshly-chosen vehicleId for the *current* counterparty from being
        // overwritten by a late-arriving auto-select.
        if (allVehicles.length === 1) setForm(f => (f.vehicleId ? f : { ...f, vehicleId: allVehicles[0].id }));
      })
      .catch((e: unknown) => {
        if (reqId !== vehicleReqRef.current) return;
        setError(e instanceof Error ? e.message : 'Помилка завантаження автомобілів');
      });
  };

  const cpName = (cp: Counterparty) =>
    cp.companyName ?? [cp.lastName, cp.firstName].filter(Boolean).join(' ') ?? '';

  const create = async () => {
    const mileage = form.inMileage ? Number(form.inMileage) : undefined;
    if (mileage !== undefined && (!Number.isFinite(mileage) || mileage < 0)) {
      setError('Пробіг повинен бути невід\'ємним числом');
      return;
    }
    setSaving(true); setError('');
    try {
      const wo = await apiFetch<WorkOrder>('/work-orders', {
        method: 'POST',
        body: JSON.stringify({
          branchId: form.branchId,
          vehicleId: form.vehicleId,
          counterpartyId: form.counterpartyId,
          description: form.description || undefined,
          inMileage: mileage,
          plannedAt: form.plannedAt || undefined,
          priority: form.priority || 'NORMAL',
          repairCategory: form.repairCategory || undefined,
          dueDate: form.dueDate || undefined,
        }),
      });
      setModal(false);
      router.push(`/work-orders/${wo.id}`);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1;

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Наряди</h1>
          <p className="page-subtitle">
            {data ? `${data.total} записів` : 'Завантаження...'}
          </p>
        </div>
        <Button onClick={() => { setError(''); setModal(true); }} leftIcon={<Plus />}>
          Новий наряд
        </Button>
      </div>

      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}

      {/* Status filter pills */}
      <div className="flex gap-1.5 mb-4 flex-wrap">
        {STATUS_TABS.map(([v, l]) => (
          <button
            key={v}
            onClick={() => { setStatusFilter(v); setPage(1); setActiveSavedFilterId(null); }}
            className={cn(
              'px-3 py-1 rounded-full text-[12px] font-medium border transition-all duration-100',
              statusFilter === v
                ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                : 'border-border text-muted-foreground bg-surface hover:bg-secondary hover:text-foreground',
            )}
          >
            {l}
          </button>
        ))}
      </div>

      {/* Saved filters */}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<WOFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          className="mb-3"
        />
      )}

      {/* "Мої наряди" quick filter chip */}
      {employee && (
        <div className="flex gap-2 mb-3">
          <button
            onClick={() => { setMyOrders(v => !v); setPage(1); setActiveSavedFilterId(null); }}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-medium border transition-all duration-100',
              myOrders
                ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                : 'border-border text-muted-foreground bg-surface hover:bg-secondary hover:text-foreground',
            )}
          >
            <User className="h-3 w-3 shrink-0" />
            Мої наряди
          </button>
        </div>
      )}

      {/* Search + category filter + showDeleted controls */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); setActiveSavedFilterId(null); }}
            placeholder="Пошук за номером або клієнтом..."
            className="pl-9"
          />
        </div>

        <Select
          value={categoryFilter}
          onChange={e => { setCategoryFilter(e.target.value); setPage(1); setActiveSavedFilterId(null); }}
          className="w-52"
        >
          <option value="">Всі категорії</option>
          {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </Select>

        <Button
          variant="outline"
          size="sm"
          onClick={() => { setShowDeleted(v => !v); setPage(1); setActiveSavedFilterId(null); }}
          className={cn(showDeleted && 'border-primary text-primary bg-primary/5')}
        >
          {showDeleted ? <EyeOff className="h-4 w-4 mr-1.5" /> : <Eye className="h-4 w-4 mr-1.5" />}
          {showDeleted ? 'Приховати видалені' : 'Показати видалені'}
        </Button>

        <ColumnsDropdown
          columns={WO_COLUMNS}
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
      <div className="flex gap-0 rounded-xl border border-border overflow-hidden">
        <div className="flex-1 min-w-0 overflow-auto border-r border-border">
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
                      aria-label="Вибрати всі"
                    />
                  </TableHead>
                )}
                {colVisible.has('number')    && <TableHead>Номер</TableHead>}
                {colVisible.has('client')    && <TableHead>Клієнт / Авто</TableHead>}
                {colVisible.has('status')    && <TableHead>Статус</TableHead>}
                {colVisible.has('priority')  && <TableHead>Пріоритет</TableHead>}
                {colVisible.has('amount')    && <TableHead>Сума, ₴</TableHead>}
                {colVisible.has('plannedAt') && <TableHead>Заплановано</TableHead>}
                {colVisible.has('dueDate')   && <TableHead>Дедлайн</TableHead>}
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
                    <EmptyState
                      icon={ClipboardList}
                      title="Нарядів не знайдено"
                      description={statusFilter ? 'Спробуйте змінити фільтр статусу' : 'Створіть перший наряд, натиснувши кнопку вище'}
                      size="sm"
                    />
                  </TableCell>
                </TableRow>
              )}

              {!loading && data?.items.map(wo => (
                <TableRow
                  key={wo.id}
                  onClick={() => setSelectedWO(wo)}
                  className={cn(
                    selectedWO?.id === wo.id && 'bg-primary/5',
                    bulkSelect.isSelected(wo.id) && 'bg-primary/5',
                  )}
                >
                  {features.bulkActionsEnabled && (
                    <TableCell className="w-9 pr-0" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={bulkSelect.isSelected(wo.id)}
                        onChange={() => bulkSelect.toggle(wo.id)}
                        className="h-3.5 w-3.5 rounded border-border"
                        aria-label={`Вибрати наряд ${wo.number}`}
                      />
                    </TableCell>
                  )}
                  {colVisible.has('number') && (
                    <TableCell>
                      <div className="space-y-1">
                        <span className="text-[13px] font-semibold text-primary">{wo.number}</span>
                        {wo.repairCategory && (
                          <p className="text-[11px] text-muted-foreground">
                            {CATEGORY_LABELS[wo.repairCategory] ?? wo.repairCategory}
                          </p>
                        )}
                      </div>
                    </TableCell>
                  )}
                  {colVisible.has('client') && (
                    <TableCell>
                      <p className="text-[13px] font-medium text-foreground">{wo.counterpartyName ?? '—'}</p>
                      <p className="text-[12px] text-muted-foreground mt-0.5">{wo.vehicleSummary ?? '—'}</p>
                    </TableCell>
                  )}
                  {colVisible.has('status') && (
                    <TableCell>
                      <Badge variant={STATUS_BADGE[wo.status] ?? 'secondary'} dot>
                        {STATUS_LABELS[wo.status] ?? wo.status}
                      </Badge>
                    </TableCell>
                  )}
                  {colVisible.has('priority') && (
                    <TableCell onClick={e => e.stopPropagation()}>
                      {inlineEdit.isEditing(wo.id, 'priority') ? (
                        <select
                          defaultValue={inlineEdit.editing?.value ?? wo.priority}
                          onChange={e => { void inlineEdit.commitEdit(e.target.value).catch(() => {}); }}
                          onBlur={() => inlineEdit.cancelEdit()}
                          onKeyDown={e => { if (e.key === 'Escape') inlineEdit.cancelEdit(); }}
                          disabled={inlineEdit.saving}
                          autoFocus
                          className="rounded border border-primary bg-surface text-[12px] text-foreground px-1.5 py-0.5 outline-none disabled:opacity-50"
                        >
                          {Object.entries(PRIORITY_LABELS).map(([v, l]) => (
                            <option key={v} value={v}>{l}</option>
                          ))}
                        </select>
                      ) : (
                        <InlineViewCell
                          value={wo.priority}
                          enabled={features.inlineEditEnabled}
                          onClick={() => inlineEdit.startEdit(wo.id, 'priority', wo.priority)}
                        >
                          <Badge variant={PRIORITY_BADGE[wo.priority] ?? 'secondary'}>
                            {PRIORITY_LABELS[wo.priority] ?? wo.priority}
                          </Badge>
                        </InlineViewCell>
                      )}
                    </TableCell>
                  )}
                  {colVisible.has('amount') && (
                    <TableCell className="font-medium text-foreground tabular-nums">
                      {wo.totalAmount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}
                    </TableCell>
                  )}
                  {colVisible.has('plannedAt') && (
                    <TableCell className="text-muted-foreground text-[12px]">
                      {wo.plannedAt
                        ? new Date(wo.plannedAt).toLocaleString('uk-UA', {
                            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                          })
                        : '—'}
                    </TableCell>
                  )}
                  {colVisible.has('dueDate') && (
                    <TableCell className="text-[12px]" onClick={e => e.stopPropagation()}>
                      {inlineEdit.isEditing(wo.id, 'dueDate') ? (
                        <InlineEditCell
                          value={wo.dueDate ? wo.dueDate.slice(0, 10) : ''}
                          saving={inlineEdit.saving}
                          onCommit={v => { void inlineEdit.commitEdit(v).catch(() => {}); }}
                          onCancel={inlineEdit.cancelEdit}
                          type="date"
                          className="w-36"
                        />
                      ) : (
                        <InlineViewCell
                          value={wo.dueDate ?? ''}
                          enabled={features.inlineEditEnabled}
                          onClick={() => inlineEdit.startEdit(wo.id, 'dueDate', wo.dueDate ? wo.dueDate.slice(0, 10) : '')}
                        >
                          {wo.dueDate ? (
                            <span className={cn(
                              'font-medium',
                              isOverdue(wo.dueDate, nowMs) ? 'text-warning' : 'text-muted-foreground',
                            )}>
                              {formatDate(wo.dueDate)}
                            </span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </InlineViewCell>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={e => { e.stopPropagation(); router.push(`/work-orders/${wo.id}`); }}
                    >
                      Відкрити →
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <DetailPanel
          open={!!selectedWO}
          onClose={() => setSelectedWO(null)}
          title={selectedWO?.number ?? ''}
        >
          {selectedWO && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={STATUS_BADGE[selectedWO.status] ?? 'secondary'} dot>
                  {STATUS_LABELS[selectedWO.status] ?? selectedWO.status}
                </Badge>
                <Badge variant={PRIORITY_BADGE[selectedWO.priority] ?? 'secondary'}>
                  {PRIORITY_LABELS[selectedWO.priority] ?? selectedWO.priority}
                </Badge>
              </div>

              <div className="space-y-2 text-[13px]">
                {selectedWO.repairCategory && (
                  <div>
                    <span className="text-muted-foreground">Категорія</span>
                    <p className="font-medium text-foreground mt-0.5">
                      {CATEGORY_LABELS[selectedWO.repairCategory] ?? selectedWO.repairCategory}
                    </p>
                  </div>
                )}
                <div>
                  <span className="text-muted-foreground">Клієнт</span>
                  <p className="font-medium text-foreground mt-0.5">{selectedWO.counterpartyName ?? '—'}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Автомобіль</span>
                  <p className="font-medium text-foreground mt-0.5">{selectedWO.vehicleSummary ?? '—'}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Сума</span>
                  <p className="font-semibold text-foreground mt-0.5 tabular-nums">
                    {selectedWO.totalAmount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
                  </p>
                </div>
                {selectedWO.dueDate && (
                  <div>
                    <span className="text-muted-foreground">Дедлайн</span>
                    <p className={cn(
                      'font-medium mt-0.5',
                      isOverdue(selectedWO.dueDate, nowMs) ? 'text-warning' : 'text-foreground',
                    )}>
                      {formatDate(selectedWO.dueDate)}
                      {isOverdue(selectedWO.dueDate, nowMs) && (
                        <span className="ml-1 text-[11px]">(прострочено)</span>
                      )}
                    </p>
                  </div>
                )}
                <div>
                  <span className="text-muted-foreground">Заплановано</span>
                  <p className="font-medium text-foreground mt-0.5">
                    {selectedWO.plannedAt
                      ? new Date(selectedWO.plannedAt).toLocaleString('uk-UA', {
                          day: '2-digit', month: '2-digit', year: 'numeric',
                          hour: '2-digit', minute: '2-digit',
                        })
                      : '—'}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Створено</span>
                  <p className="font-medium text-foreground mt-0.5">
                    {new Date(selectedWO.createdAt).toLocaleString('uk-UA', {
                      day: '2-digit', month: '2-digit', year: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </p>
                </div>
              </div>

              <Button
                className="w-full"
                size="sm"
                onClick={() => router.push(`/work-orders/${selectedWO.id}`)}
              >
                Відкрити наряд
              </Button>
            </div>
          )}
        </DetailPanel>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-1.5 mt-4">
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

      {/* Create modal */}
      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Новий наряд"
        description="Заповніть дані для створення наряду"
        footer={
          <Button
            onClick={create}
            loading={saving}
            disabled={!form.branchId || !form.vehicleId || !form.counterpartyId}
            className="w-full sm:w-auto"
          >
            Створити наряд
          </Button>
        }
      >
        {formError && (
          <div className="mb-4 text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2">
            {formError}
          </div>
        )}

        <div className="space-y-4">
          {templates.length > 0 && (
            <Select
              label="Шаблон (необов'язково)"
              value=""
              onChange={e => {
                const tpl = templates.find(t => t.id === e.target.value);
                if (!tpl) return;
                // Prefix description so the user immediately sees which template was applied.
                // Plain `tpl.name` would overwrite the field with what looks like an actual
                // description and obscure the fact that lines/parts auto-apply is not (yet)
                // implemented for the create form — see Bug #67 in BUG_REPORT.md.
                setForm(f => ({
                  ...f,
                  description: `Створено за шаблоном «${tpl.name}»`,
                }));
              }}
            >
              <option value="">— Без шаблону —</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </Select>
          )}

          <Select
            label="Клієнт"
            required
            value={form.counterpartyId}
            onChange={e => {
              setForm(f => ({ ...f, counterpartyId: e.target.value, vehicleId: '' }));
              loadVehicles(e.target.value);
            }}
          >
            <option value="">— Оберіть —</option>
            {counterparties.map(c => (
              <option key={c.id} value={c.id}>{cpName(c)}</option>
            ))}
          </Select>

          <Select
            label="Автомобіль"
            required
            value={form.vehicleId}
            onChange={e => setForm(f => ({ ...f, vehicleId: e.target.value }))}
            disabled={!form.counterpartyId}
          >
            <option value="">— Оберіть —</option>
            {vehicles.map(v => (
              <option key={v.id} value={v.id}>
                {v.make} {v.model}{v.licensePlate ? ` (${v.licensePlate})` : ''}
              </option>
            ))}
          </Select>

          <Select
            label="Філія"
            required
            value={form.branchId}
            onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}
          >
            <option value="">— Оберіть —</option>
            {branches.map(b => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </Select>

          <Input
            label="Опис"
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            placeholder="Заміна масла, колодок..."
          />

          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Пріоритет"
              value={form.priority}
              onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
            >
              {Object.entries(PRIORITY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
            <Select
              label="Категорія ремонту"
              value={form.repairCategory}
              onChange={e => setForm(f => ({ ...f, repairCategory: e.target.value }))}
            >
              <option value="">— Не вказано —</option>
              {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Пробіг (вхід), км"
              type="number"
              value={form.inMileage}
              onChange={e => setForm(f => ({ ...f, inMileage: e.target.value }))}
              placeholder="50000"
            />
            <Input
              label="Заплановано"
              type="datetime-local"
              value={form.plannedAt}
              onChange={e => setForm(f => ({ ...f, plannedAt: e.target.value }))}
            />
          </div>

          <DatePickerInput
            label="Дедлайн"
            value={form.dueDate}
            onChange={v => setForm(f => ({ ...f, dueDate: v }))}
          />
        </div>
      </Modal>
    </div>
  );
}
