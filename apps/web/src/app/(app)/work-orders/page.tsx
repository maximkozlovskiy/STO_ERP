'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Plus, ClipboardList, Eye, EyeOff, Search, User, ExternalLink, Trash2 } from 'lucide-react';
import { useRequireAuth, useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { useWorkOrders, workOrdersKeys, WorkOrder } from '@/hooks/api/useWorkOrders';
import { EMPTY_ITEMS } from '@/hooks/api/usePaginatedList';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  WO_STATUS_LABELS,
  WO_STATUS_BADGE,
  WO_PRIORITY_LABELS,
  WO_PRIORITY_BADGE,
  WO_CATEGORY_LABELS,
} from '@sto/shared';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pagination } from '@/components/ui/pagination';
import { useConfirm } from '@/hooks/useConfirm';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchCombobox } from '@/components/ui/search-combobox';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { DetailPanel, PanelField, type DetailPanelTab } from '@/components/ui/detail-panel';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import { useDetailPanel } from '@/hooks/useDetailPanel';
import { useDetailPanelConfig } from '@/hooks/useDetailPanelConfig';
import {
  WORK_ORDER_PANEL_SCHEMA,
  buildPanelFields,
  schemaToPanelConfigFields,
} from '@/lib/panel-schema';
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { InlineEditCell, InlineViewCell } from '@/components/ui/inline-edit-cell';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { useInlineEdit } from '@/hooks/useInlineEdit';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useTableColumns } from '@/hooks/useTableColumns';
import { useColumnDrag } from '@/hooks/useColumnDrag';
import { toast } from '@/lib/toast';
import { cn, displayCounterpartyName } from '@/lib/utils';
import { fmtMoney, fmtDate, fmtShortDateTime, fmtDateTime } from '@/lib/format';

// Module-level formatter — produces YYYY-MM-DD in Kyiv local time (DST-aware).
const KYIV_YMD = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });
const kyivToday = () => KYIV_YMD.format(new Date());

interface Branch {
  id: string;
  name: string;
}
interface Vehicle {
  id: string;
  make: string;
  model: string;
  licensePlate: string | null;
}
interface Counterparty {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}
interface WOTemplate {
  id: string;
  name: string;
  lines: { workId: string; quantity: number; note?: string }[];
  parts: { goodId: string; quantity: number }[];
}

interface WOFilters extends Record<string, unknown> {
  statusFilter: string;
  categoryFilter: string;
  search: string;
  showDeleted: boolean;
  myOrders: boolean;
  dateFrom: string;
  dateTo: string;
}

// Status/badge/priority/category constants imported from @sto/shared
const STATUS_LABELS = WO_STATUS_LABELS;
const STATUS_BADGE = WO_STATUS_BADGE;
const PRIORITY_LABELS = WO_PRIORITY_LABELS;
const PRIORITY_BADGE = WO_PRIORITY_BADGE;
const CATEGORY_LABELS = WO_CATEGORY_LABELS;

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
  const queryClient = useQueryClient();
  const { employee } = useAuth();
  const router = useRouter();
  const { confirm, dialogProps: confirmDialogProps } = useConfirm();

  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    setNowMs(Date.now());
  }, []);

  // Local filter & pagination state
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [showDeleted, setShowDeleted] = useState(false);
  const [dateFrom, setDateFrom] = useState(() => kyivToday());
  const [dateTo, setDateTo] = useState(() => kyivToday());
  // Default to "my orders" for MECHANICs — initialized lazily after employee loads
  const [myOrders, setMyOrders] = useState(false);
  const myOrdersInitRef = useRef(false);
  const [selectedWO, setSelectedWO] = useState<WorkOrder | null>(null);
  const detailPanel = useDetailPanel('work-orders');
  const panelConfig = useDetailPanelConfig('work-orders-panel');

  // Auto-activate "my orders" chip once for MECHANIC role (run only once after employee loads).
  // Must be declared AFTER the `myOrdersInitRef` and `setMyOrders` it references, otherwise TDZ
  // ReferenceError fires on first render.
  useEffect(() => {
    if (employee && !myOrdersInitRef.current) {
      myOrdersInitRef.current = true;
      if (employee.role === 'MECHANIC') setMyOrders(true);
    }
  }, [employee]);

  // React Query hooks
  const limit = 20;
  const {
    data: queryData,
    isLoading: loading,
    error: queryError,
  } = useWorkOrders({
    page,
    limit,
    status: statusFilter,
    repairCategory: categoryFilter || undefined,
    q: debouncedSearch,
    showDeleted,
    employeeId: myOrders ? employee?.id : undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  });
  // Bug #328 regression guard: fresh `[]` literal per render → useBulkSelect
  // effect fires on every render. Use module-level frozen EMPTY_ITEMS instead.
  const orders = queryData?.items ?? (EMPTY_ITEMS as unknown as WorkOrder[]);
  const total = queryData?.total ?? 0;

  // Modal & form state
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);

  const [branches, setBranches] = useState<Branch[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [counterpartyDisplayName, setCounterpartyDisplayName] = useState('');
  const [templates, setTemplates] = useState<WOTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<WOTemplate | null>(null);

  const features = useUiFeatures();

  const WO_COLUMNS = useMemo(
    () => [
      { key: 'number', label: 'Номер' },
      { key: 'client', label: 'Клієнт / Авто' },
      { key: 'status', label: 'Статус' },
      { key: 'priority', label: 'Пріоритет' },
      { key: 'amount', label: 'Сума, ₴' },
      { key: 'documentDate', label: 'Дата документа' },
      { key: 'plannedAt', label: 'Заплановано' },
      { key: 'dueDate', label: 'Дедлайн' },
    ],
    [],
  );

  const {
    visibleKeys: colVisible,
    visibleColumns,
    orderedColumns,
    order,
    customLabels,
    toggle: toggleCol,
    reorder,
    renameColumn,
    resetConfig,
  } = useTableColumns('work-orders', WO_COLUMNS);
  const { dragProps } = useColumnDrag(visibleColumns, reorder, orderedColumns);

  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const {
    saved: savedFilters,
    save: saveFilter,
    remove: removeFilter,
  } = useSavedFilters<WOFilters>('work-orders');

  const applyFilter = useCallback((preset: { id: string; filters: WOFilters }) => {
    setStatusFilter(preset.filters.statusFilter ?? '');
    setCategoryFilter(preset.filters.categoryFilter ?? '');
    setSearch(preset.filters.search ?? '');
    setShowDeleted(preset.filters.showDeleted ?? false);
    setMyOrders(preset.filters.myOrders ?? false);
    setDateFrom(preset.filters.dateFrom ?? '');
    setDateTo(preset.filters.dateTo ?? '');
    setPage(1);
    setActiveSavedFilterId(preset.id);
  }, []);

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = saveFilter(name, {
        statusFilter,
        categoryFilter,
        search,
        showDeleted,
        myOrders,
        dateFrom,
        dateTo,
      });
      setActiveSavedFilterId(preset.id);
      if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
    },
    [
      saveFilter,
      statusFilter,
      categoryFilter,
      search,
      showDeleted,
      myOrders,
      dateFrom,
      dateTo,
      features.toastEnabled,
    ],
  );

  const bulkSelect = useBulkSelect(orders);

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
        queryClient.invalidateQueries({ queryKey: workOrdersKeys.all });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Помилка збереження';
        if (features.toastEnabled) toast.error(msg);
        else setError(msg);
        throw e; // bubble so useInlineEdit keeps editing state for retry
      }
    },
  });
  const [form, setForm] = useState({
    branchId: '',
    vehicleId: '',
    counterpartyId: '',
    description: '',
    inMileage: '',
    plannedAt: '',
    priority: 'NORMAL',
    repairCategory: '',
    dueDate: '',
    documentDate: kyivToday(),
  });

  useEffect(() => {
    let cancelled = false;
    // Paint instantly from typed ref-cache helpers; fall through to fetch if missing
    const cachedBranches = getCached<Branch[]>('cache:branches');
    const cachedTemplates = getCached<WOTemplate[]>('cache:wo-templates');
    if (cachedBranches && cachedTemplates) {
      setBranches(cachedBranches);
      if (cachedBranches.length === 1)
        setForm(f => (f.branchId ? f : { ...f, branchId: cachedBranches[0].id }));
      setTemplates(cachedTemplates);
      return;
    }
    // Parallel fetch — branches and templates in one round trip
    Promise.all([
      apiFetch<Branch[]>('/branches'),
      apiFetch<{ items: WOTemplate[] }>('/work-order-templates?limit=100'),
    ])
      .then(([bs, tmpl]) => {
        if (cancelled) return;
        setBranches(bs);
        if (bs.length === 1) setForm(f => (f.branchId ? f : { ...f, branchId: bs[0].id }));
        setTemplates(tmpl.items);
        setCache('cache:branches', bs);
        setCache('cache:wo-templates', tmpl.items);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setFormError(e instanceof Error ? e.message : 'Не вдалося завантажити дані');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Bulk transition helper:
  //   - Uses Promise.allSettled so a single FSM-invalid transition doesn't
  //     abort the whole batch (e.g. ARCHIVE works only from PAID — the rest
  //     would otherwise leave the UI with stale selection + no feedback).
  //   - Always clears the selection and reloads, regardless of partial errors.
  //   - Aggregates the result into one toast: "Скасовано 3, не вдалось 2".
  const bulkTransition = useCallback(
    async (ids: string[], status: 'CANCELLED' | 'ARCHIVED', successLabel: string) => {
      const results = await Promise.allSettled(
        ids.map(id =>
          apiFetch(`/work-orders/${id}/transition`, {
            method: 'POST',
            body: JSON.stringify({ status }),
          }),
        ),
      );
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.length - succeeded;

      bulkSelect.clear();
      queryClient.invalidateQueries({ queryKey: workOrdersKeys.all });

      if (features.toastEnabled) {
        if (succeeded > 0 && failed === 0) {
          toast.success(`${successLabel} ${succeeded} ${succeeded === 1 ? 'наряд' : 'нарядів'}`);
        } else if (succeeded > 0 && failed > 0) {
          toast.warning(
            `${successLabel} ${succeeded} з ${results.length}. ${failed} не змінено (статус не дозволяє)`,
          );
        } else {
          // 0 succeeded — surface first error message if any
          const firstError = results.find(
            (r): r is PromiseRejectedResult => r.status === 'rejected',
          );
          const errMsg =
            firstError?.reason instanceof Error
              ? firstError.reason.message
              : 'жоден наряд не змінено (статус не дозволяє)';
          toast.error(errMsg);
        }
      } else if (failed > 0) {
        setError(`${succeeded} з ${results.length} нарядів змінено, ${failed} не вдалось`);
      }
    },
    [bulkSelect, features.toastEnabled, queryClient],
  );

  const bulkCancel = useCallback(
    (ids: string[]) => bulkTransition(ids, 'CANCELLED', 'Скасовано'),
    [bulkTransition],
  );
  const bulkArchive = useCallback(
    (ids: string[]) => bulkTransition(ids, 'ARCHIVED', 'Архівовано'),
    [bulkTransition],
  );

  const bulkActions = useMemo<BulkAction[]>(
    () => [
      { id: 'cancel', label: 'Скасувати', variant: 'destructive', onClick: bulkCancel },
      { id: 'archive', label: 'Архівувати', variant: 'outline', onClick: bulkArchive },
    ],
    [bulkCancel, bulkArchive],
  );

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
            apiFetch<Vehicle[]>(`/vehicles?customerGarageId=${g.id}`).catch(() => [] as Vehicle[]),
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
        if (allVehicles.length === 1)
          setForm(f => (f.vehicleId ? f : { ...f, vehicleId: allVehicles[0].id }));
      })
      .catch((e: unknown) => {
        if (reqId !== vehicleReqRef.current) return;
        setError(e instanceof Error ? e.message : 'Помилка завантаження автомобілів');
      });
  };

  const create = async () => {
    const mileage = form.inMileage ? Number(form.inMileage) : undefined;
    if (mileage !== undefined && (!Number.isFinite(mileage) || mileage < 0)) {
      setError("Пробіг повинен бути невід'ємним числом");
      return;
    }
    setSaving(true);
    setError('');
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
          documentDate: form.documentDate || undefined,
        }),
      });
      // Bug #212: invalidate workOrders cache до router.push щоб коли юзер натисне back
      // у межах 30s staleTime — список ре-fetch-нувся і показав щойно створений наряд.
      queryClient.invalidateQueries({ queryKey: workOrdersKeys.all });
      setModal(false);
      router.push(`/work-orders/${wo.id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSaving(false);
    }
  };

  const markDeleted = async (wo: WorkOrder) => {
    if (
      !(await confirm({
        title: `Позначити наряд ${wo.number} на видалення?`,
        variant: 'destructive',
      }))
    )
      return;
    try {
      await apiFetch(`/work-orders/${wo.id}`, { method: 'DELETE' });
      if (selectedWO?.id === wo.id) setSelectedWO(null);
      queryClient.invalidateQueries({ queryKey: workOrdersKeys.all });
      toast.success('Наряд позначено на видалення');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Помилка видалення');
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Наряди</h1>
          <p className="page-subtitle">{`${total} записів`}</p>
        </div>
      </div>

      {!modal && (error || queryError) && (
        <div className="mb-4 text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-4 py-2.5">
          {error || (queryError instanceof Error ? queryError.message : '')}
        </div>
      )}

      {/* Status filter pills + Мої наряди */}
      <div className="flex gap-1.5 flex-wrap items-center justify-between shrink-0">
        <div className="flex gap-1.5 flex-wrap">
          {STATUS_TABS.map(([v, l]) => (
            <button
              key={v}
              onClick={() => {
                setStatusFilter(v);
                setPage(1);
                setActiveSavedFilterId(null);
              }}
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
        {employee && (
          <button
            onClick={() => {
              setMyOrders(v => !v);
              setPage(1);
              setActiveSavedFilterId(null);
            }}
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
        )}
      </div>

      {/* Saved filters */}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<WOFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          hideSaveButton
        />
      )}

      {/* Search + category filter + showDeleted controls */}
      <div className="flex flex-wrap gap-3 shrink-0">
        <Input
          value={search}
          onChange={e => {
            setSearch(e.target.value);
            setPage(1);
            setActiveSavedFilterId(null);
          }}
          placeholder="Пошук за номером або клієнтом..."
          leftElement={<Search />}
          className="w-72"
        />
        <DatePickerInput
          value={dateFrom}
          onChange={v => {
            setDateFrom(v);
            setPage(1);
            setActiveSavedFilterId(null);
          }}
          placeholder="Від"
          max={dateTo || undefined}
          className="w-36"
        />
        <DatePickerInput
          value={dateTo}
          onChange={v => {
            setDateTo(v);
            setPage(1);
            setActiveSavedFilterId(null);
          }}
          placeholder="До"
          min={dateFrom || undefined}
          className="w-36"
        />

        <Select
          value={categoryFilter}
          onChange={e => {
            setCategoryFilter(e.target.value);
            setPage(1);
            setActiveSavedFilterId(null);
          }}
          className="w-52"
        >
          <option value="">Всі категорії</option>
          {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>

        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="outline"
            size="icon-sm"
            title={showDeleted ? 'Сховати видалені' : 'Показати видалені'}
            onClick={() => {
              setShowDeleted(v => !v);
              setPage(1);
              setActiveSavedFilterId(null);
            }}
            className={cn(showDeleted && 'border-primary text-primary')}
          >
            {showDeleted ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
          {features.savedFiltersEnabled && <SaveFilterButton onSave={handleSaveFilter} />}
          <ColumnsDropdown
            columns={orderedColumns}
            visibleKeys={colVisible}
            onToggle={toggleCol}
            onReorder={reorder}
            onRename={renameColumn}
            onReset={resetConfig}
            hasCustomization={
              JSON.stringify(order) !== JSON.stringify(WO_COLUMNS.map(c => c.key)) ||
              Object.keys(customLabels).length > 0
            }
          />
          <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
          <Button
            onClick={() => {
              setError('');
              setModal(true);
            }}
            leftIcon={<Plus className="h-4 w-4" />}
          >
            Наряд
          </Button>
        </div>
      </div>

      {/* Bulk actions */}
      {features.bulkActionsEnabled && bulkSelect.count > 0 && (
        <BulkActionsBar
          count={bulkSelect.count}
          selectedIds={Array.from(bulkSelect.selected)}
          actions={bulkActions}
          onClear={bulkSelect.clear}
        />
      )}

      {/* Table + DetailPanel */}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-h-0 min-w-0 overflow-auto bg-surface rounded-xl border border-border">
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
                {visibleColumns.map(col =>
                  col.key === 'amount' ? (
                    <TableHead key={col.key} className="text-right" {...dragProps(col.key)}>
                      {col.label}
                    </TableHead>
                  ) : (
                    <TableHead key={col.key} {...dragProps(col.key)}>
                      {col.label}
                    </TableHead>
                  ),
                )}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell
                    colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)}
                    className="py-12 text-center"
                  >
                    <div className="flex justify-center">
                      <Spinner size="md" />
                    </div>
                  </TableCell>
                </TableRow>
              )}

              {!loading && orders.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)}
                    className="p-0"
                  >
                    <EmptyState
                      icon={ClipboardList}
                      title="Нарядів не знайдено"
                      description={
                        statusFilter
                          ? 'Спробуйте змінити фільтр статусу'
                          : 'Створіть перший наряд, натиснувши кнопку вище'
                      }
                      size="sm"
                    />
                  </TableCell>
                </TableRow>
              )}

              {!loading &&
                orders.map((wo: WorkOrder) => (
                  <TableRow
                    key={wo.id}
                    onClick={() =>
                      detailPanel.enabled && setSelectedWO(prev => (prev?.id === wo.id ? null : wo))
                    }
                    className={cn(
                      'group transition-colors',
                      detailPanel.enabled && 'cursor-pointer',
                      wo.deletedAt && 'opacity-60',
                      selectedWO?.id === wo.id && detailPanel.enabled && 'bg-primary/5',
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
                    {visibleColumns.map(col => {
                      if (col.key === 'number')
                        return (
                          <TableCell key="number">
                            <div className="space-y-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-[13px] font-semibold text-primary">
                                  {wo.number}
                                </span>
                              </div>
                              {wo.repairCategory && (
                                <p className="text-[11px] text-muted-foreground">
                                  {CATEGORY_LABELS[wo.repairCategory] ?? wo.repairCategory}
                                </p>
                              )}
                            </div>
                          </TableCell>
                        );
                      if (col.key === 'client')
                        return (
                          <TableCell key="client">
                            <p className="text-[13px] font-medium text-foreground">
                              {wo.counterpartyName ?? '—'}
                            </p>
                            <p className="text-[12px] text-muted-foreground mt-0.5">
                              {wo.vehicleSummary ?? '—'}
                            </p>
                          </TableCell>
                        );
                      if (col.key === 'status')
                        return (
                          <TableCell key="status">
                            <Badge variant={STATUS_BADGE[wo.status] ?? 'secondary'} dot>
                              {STATUS_LABELS[wo.status] ?? wo.status}
                            </Badge>
                          </TableCell>
                        );
                      if (col.key === 'priority')
                        return (
                          <TableCell key="priority" onClick={e => e.stopPropagation()}>
                            {inlineEdit.isEditing(wo.id, 'priority') ? (
                              <select
                                defaultValue={inlineEdit.editing?.value ?? wo.priority ?? ''}
                                onChange={e => {
                                  void inlineEdit.commitEdit(e.target.value).catch(() => {});
                                }}
                                onBlur={() => inlineEdit.cancelEdit()}
                                onKeyDown={e => {
                                  if (e.key === 'Escape') inlineEdit.cancelEdit();
                                }}
                                disabled={inlineEdit.saving}
                                autoFocus
                                className="rounded border border-primary bg-surface text-[12px] text-foreground px-1.5 py-0.5 outline-none disabled:opacity-50"
                              >
                                {Object.entries(PRIORITY_LABELS).map(([v, l]) => (
                                  <option key={v} value={v}>
                                    {l}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <InlineViewCell
                                value={wo.priority ?? ''}
                                enabled={features.inlineEditEnabled}
                                onClick={() =>
                                  wo.priority &&
                                  inlineEdit.startEdit(wo.id, 'priority', wo.priority)
                                }
                              >
                                {wo.priority && (
                                  <Badge variant={PRIORITY_BADGE[wo.priority] ?? 'secondary'}>
                                    {PRIORITY_LABELS[wo.priority] ?? wo.priority}
                                  </Badge>
                                )}
                              </InlineViewCell>
                            )}
                          </TableCell>
                        );
                      if (col.key === 'amount')
                        return (
                          <TableCell
                            key="amount"
                            className="font-medium text-foreground tabular-nums text-right"
                          >
                            {fmtMoney(wo.totalAmount)}
                          </TableCell>
                        );
                      if (col.key === 'documentDate')
                        return (
                          <TableCell
                            key="documentDate"
                            className="text-[13px] text-muted-foreground"
                          >
                            {wo.documentDate ? fmtDate(wo.documentDate) : '—'}
                          </TableCell>
                        );
                      if (col.key === 'plannedAt')
                        return (
                          <TableCell key="plannedAt" className="text-muted-foreground text-[12px]">
                            {wo.plannedAt ? fmtShortDateTime(wo.plannedAt) : '—'}
                          </TableCell>
                        );
                      if (col.key === 'dueDate')
                        return (
                          <TableCell
                            key="dueDate"
                            className="text-[12px]"
                            onClick={e => e.stopPropagation()}
                          >
                            {inlineEdit.isEditing(wo.id, 'dueDate') ? (
                              <InlineEditCell
                                value={wo.dueDate ? wo.dueDate.slice(0, 10) : ''}
                                saving={inlineEdit.saving}
                                onCommit={v => {
                                  void inlineEdit.commitEdit(v).catch(() => {});
                                }}
                                onCancel={inlineEdit.cancelEdit}
                                type="date"
                                className="w-36"
                              />
                            ) : (
                              <InlineViewCell
                                value={wo.dueDate ?? ''}
                                enabled={features.inlineEditEnabled}
                                onClick={() =>
                                  inlineEdit.startEdit(
                                    wo.id,
                                    'dueDate',
                                    wo.dueDate ? wo.dueDate.slice(0, 10) : '',
                                  )
                                }
                              >
                                {wo.dueDate ? (
                                  <span
                                    className={cn(
                                      'font-medium',
                                      isOverdue(wo.dueDate, nowMs)
                                        ? 'text-warning'
                                        : 'text-muted-foreground',
                                    )}
                                  >
                                    {formatDate(wo.dueDate)}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </InlineViewCell>
                            )}
                          </TableCell>
                        );
                      return null;
                    })}
                    <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Відкрити наряд"
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => router.push(`/work-orders/${wo.id}`)}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Button>
                        {!wo.deletedAt && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Позначити на видалення"
                            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                            onClick={() => void markDeleted(wo)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>

        {(() => {
          const buildWOTabs = (wo: WorkOrder): DetailPanelTab[] => [
            {
              key: 'info',
              label: 'Основне',
              content: (
                <div className="space-y-3">
                  {buildPanelFields(wo, WORK_ORDER_PANEL_SCHEMA, panelConfig.config, {
                    status: v => (
                      <Badge variant={STATUS_BADGE[String(v)] ?? 'secondary'} dot>
                        {STATUS_LABELS[String(v)] ?? String(v)}
                      </Badge>
                    ),
                    priority: v =>
                      v ? (
                        <Badge variant={PRIORITY_BADGE[String(v)] ?? 'secondary'}>
                          {PRIORITY_LABELS[String(v)] ?? String(v)}
                        </Badge>
                      ) : undefined,
                    repairCategory: v =>
                      v ? (CATEGORY_LABELS[String(v)] ?? String(v)) : undefined,
                    dueDate: v =>
                      v ? (
                        <span
                          className={cn(
                            'font-medium',
                            isOverdue(String(v), nowMs) ? 'text-warning' : undefined,
                          )}
                        >
                          {formatDate(String(v))}
                          {isOverdue(String(v), nowMs) && (
                            <span className="ml-1 text-[11px]">(прострочено)</span>
                          )}
                        </span>
                      ) : undefined,
                  }).map(f => (
                    <PanelField
                      key={f.key}
                      fieldKey={f.key}
                      label={f.label}
                      value={f.value}
                      hidden={f.hidden}
                    />
                  ))}
                  <Button
                    className="w-full"
                    size="sm"
                    onClick={() => router.push(`/work-orders/${wo.id}`)}
                  >
                    Відкрити наряд
                  </Button>
                </div>
              ),
            },
          ];
          return (
            <DetailPanel
              open={!!selectedWO && detailPanel.enabled}
              onClose={() => setSelectedWO(null)}
              title={selectedWO?.number ?? ''}
              tabs={selectedWO ? buildWOTabs(selectedWO) : undefined}
              configFields={schemaToPanelConfigFields(WORK_ORDER_PANEL_SCHEMA, panelConfig.config)}
              onToggleField={panelConfig.toggleField}
              onReorderFields={panelConfig.reorderFields}
              onReset={panelConfig.reset}
            />
          );
        })()}
      </div>

      {/* Pagination */}
      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      {/* Create modal */}
      <Modal
        open={modal}
        onClose={() => {
          setModal(false);
          setSelectedTemplate(null);
          setCounterpartyDisplayName('');
          setVehicles([]);
          setForm(f => ({
            ...f,
            counterpartyId: '',
            vehicleId: '',
            description: '',
            inMileage: '',
            plannedAt: '',
            priority: 'NORMAL',
            repairCategory: '',
            dueDate: '',
            documentDate: kyivToday(),
          }));
        }}
        title="Новий наряд"
        description="Заповніть дані для створення наряду"
        size="xl"
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
            <div>
              <Select
                label="Шаблон (необов'язково)"
                value={selectedTemplate?.id ?? ''}
                onChange={e => {
                  const tpl = templates.find(t => t.id === e.target.value) ?? null;
                  setSelectedTemplate(tpl);
                  if (tpl) {
                    setForm(f => ({ ...f, description: `Створено за шаблоном «${tpl.name}»` }));
                  }
                }}
              >
                <option value="">— Без шаблону —</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
              {selectedTemplate &&
                (selectedTemplate.lines.length > 0 || selectedTemplate.parts.length > 0) && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {/* Bug #266: попередній текст брехав «буде додано після відкриття». */}
                    {/* Бекенд не копіює lines/parts при створенні (потребує employeeId + */}
                    {/* warehouseId які не зберігаються у шаблоні), тому користувач має */}
                    {/* додати їх вручну на сторінці наряду. */}
                    Шаблон містить:{' '}
                    {selectedTemplate.lines.length > 0 && `${selectedTemplate.lines.length} роб.`}
                    {selectedTemplate.lines.length > 0 && selectedTemplate.parts.length > 0 && ', '}
                    {selectedTemplate.parts.length > 0 && `${selectedTemplate.parts.length} запч.`}
                    {' — '} додайте вручну на сторінці наряду після створення
                  </p>
                )}
            </div>
          )}

          <SearchCombobox<Counterparty>
            label="Клієнт"
            required
            placeholder="Ім'я, телефон, держ. номер авто..."
            value={form.counterpartyId}
            displayValue={counterpartyDisplayName}
            onSelect={cp => {
              // Bug #139: helper повертає '(без імені)' fallback замість порожнього рядка.
              setCounterpartyDisplayName(displayCounterpartyName(cp));
              setForm(f => ({ ...f, counterpartyId: cp.id, vehicleId: '' }));
              loadVehicles(cp.id);
            }}
            onClear={() => {
              setCounterpartyDisplayName('');
              setForm(f => ({ ...f, counterpartyId: '', vehicleId: '' }));
              setVehicles([]);
            }}
            fetchItems={q =>
              apiFetch<{ items: Counterparty[] }>(
                `/counterparties?q=${encodeURIComponent(q)}&limit=10`,
              ).then(r =>
                r.items.map(c => ({
                  ...c,
                  primary: displayCounterpartyName(c),
                })),
              )
            }
          />

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
                {v.make} {v.model}
                {v.licensePlate ? ` (${v.licensePlate})` : ''}
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
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
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
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <Select
              label="Категорія ремонту"
              value={form.repairCategory}
              onChange={e => setForm(f => ({ ...f, repairCategory: e.target.value }))}
            >
              <option value="">— Не вказано —</option>
              {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
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
          <DatePickerInput
            label="Дата документа"
            value={form.documentDate}
            onChange={v => setForm(f => ({ ...f, documentDate: v }))}
          />
        </div>
      </Modal>

      <ConfirmDialog {...confirmDialogProps} />
    </div>
  );
}
