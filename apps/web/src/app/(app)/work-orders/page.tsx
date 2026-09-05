'use client';

import { useEffect, useState, useCallback, useMemo, useRef, Suspense, memo } from 'react';
import type { ElementType } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Plus,
  ClipboardList,
  Eye,
  EyeOff,
  Search,
  User,
  Pencil,
  Copy,
  Trash2,
  Receipt,
  CreditCard,
  Calendar,
  Shield,
} from 'lucide-react';
import { LinkedDocumentsPanel } from '@/components/ui/LinkedDocumentsPanel';
import { workOrderLinkedConfig } from '@/lib/linked-configs';
import { useLinkedNav } from '@/lib/linked-nav';
import { useRequireAuth, useAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { useWorkOrders, workOrdersKeys, WorkOrder } from '@/hooks/api/useWorkOrders';
import { EMPTY_ITEMS } from '@/hooks/api/usePaginatedList';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  WO_STATUS_LABELS,
  WO_STATUS_BADGE,
  WO_STATUS_DESCRIPTIONS,
  WO_PRIORITY_LABELS,
  WO_PRIORITY_BADGE,
  WO_CATEGORY_LABELS,
} from '@sto/shared';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pagination } from '@/components/ui/pagination';
import { useConfirm } from '@/hooks/useConfirm';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import dynamic from 'next/dynamic';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  SortableHead,
  TableCell,
} from '@/components/ui/table';
import { useSortState } from '@/hooks/useSortState';
import { useSubmitGuard } from '@/hooks/useSubmitGuard';
import { DetailPanel, PanelField, type DetailPanelTab } from '@/components/ui/detail-panel';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import { TableContainer } from '@/components/ui/table-container';
import { Tooltip } from '@/components/ui/tooltip';
import { StatusPill } from '@/components/ui/status-pill';
import {
  WORK_ORDER_PANEL_SCHEMA,
  buildPanelFields,
  schemaToPanelConfigFields,
} from '@/lib/panel-schema';
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { type SavedFilter } from '@/hooks/useSavedFilters';
import { InlineEditCell, InlineViewCell } from '@/components/ui/inline-edit-cell';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { useListPage } from '@/hooks/useListPage';
import { useInlineEdit } from '@/hooks/useInlineEdit';
import { useBulkIndeterminate } from '@/hooks/useBulkIndeterminate';
import { toast } from '@/lib/toast';
import { invalidateWorkOrderSideEffects } from '@/lib/cache-invalidation';
import { rowStatusTone, rowStatusBorderClass, rowStatusLabel } from '@/lib/row-status';
import { cn } from '@/lib/utils';
import { fmtMoney, fmtDate, fmtShortDateTime, kyivToday } from '@/lib/format';

// sto-optimize: CreateWorkOrderModal — 1823 LOC + EntityPickerField + усі form sub-components.
// Список нарядів відкривається в 80% сесій без створення нового → modal lazy-loaded
// при першому кліку «Створити». Type-only import зберігає TypeScript intelligence.
const CreateWorkOrderModal = dynamic(
  () => import('@/components/ui/CreateWorkOrderModal').then(m => m.CreateWorkOrderModal),
  { ssr: false },
);

// Module-level formatter — produces YYYY-MM-DD in Kyiv local time (DST-aware).

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

const STATUS_DESCRIPTIONS = WO_STATUS_DESCRIPTIONS;
const PRIORITY_LABELS = WO_PRIORITY_LABELS;
const PRIORITY_BADGE = WO_PRIORITY_BADGE;
const CATEGORY_LABELS = WO_CATEGORY_LABELS;

const STATUS_TABS: Array<[string, string]> = [
  ['', 'Всі'],
  ['DRAFT', 'Чернетка'],
  ['ESTIMATE', 'Кошторис'],
  ['APPROVED', 'Затверджено'],
  ['IN_PROGRESS', 'В роботі'],
  ['ON_HOLD', 'Призупинено'],
  ['COMPLETED', 'Виконано'],
  ['INVOICED', 'Виставлено'],
  ['PAID', 'Оплачено'],
  ['ARCHIVED', 'Архів'],
  ['CANCELLED', 'Скасовано'],
];

type LinkedCountsEntry = {
  invoices: number;
  payments: number;
  calendarSlots: number;
  warranties: number;
};
type LinkedCountsField = keyof LinkedCountsEntry;
type LinkedCountsMap = Record<string, LinkedCountsEntry>;

// Stable empty fallback — module-level frozen reference avoids fresh {} per render
// (Bug #328 cascade pattern: even if not feeding useEffect today, a future hook
// that depends on linkedCounts identity would re-fire each render with a literal).
const EMPTY_LINKED_COUNTS: LinkedCountsMap = Object.freeze({}) as LinkedCountsMap;

const DOC_COUNTERS: Array<{
  field: LinkedCountsField;
  Icon: ElementType;
  label: string;
}> = [
  { field: 'invoices', Icon: Receipt, label: 'Рахунки' },
  { field: 'payments', Icon: CreditCard, label: 'Оплати' },
  { field: 'calendarSlots', Icon: Calendar, label: 'Записи календаря' },
  { field: 'warranties', Icon: Shield, label: 'Гарантії' },
];

function isOverdue(dueDateIso: string, nowMs: number): boolean {
  const due = new Date(dueDateIso);
  due.setHours(23, 59, 59, 999);
  return due.getTime() < nowMs;
}

// Наряд «активний» (дедлайн ще горить), поки не в термінальному/оплаченому статусі.
const WO_INACTIVE_STATUSES = new Set(['CANCELLED', 'ARCHIVED', 'PAID']);

// Module-level constants — стабільні референси між рендерами, замість per-render
// allocate у useMemo. WO_COLUMNS_DEFAULT_KEYS_JSON знімає `JSON.stringify(map())`
// з кожного render (hasCustomization comparison у toolbar).
const WO_COLUMNS: Array<{ key: string; label: string }> = [
  { key: 'number', label: 'Номер' },
  { key: 'client', label: 'Клієнт / Авто' },
  { key: 'status', label: 'Статус' },
  { key: 'lift', label: 'Підйомник' },
  { key: 'priority', label: 'Пріоритет' },
  { key: 'amount', label: 'Сума, ₴' },
  { key: 'documentDate', label: 'Дата документа' },
  { key: 'plannedAt', label: 'Заплановано' },
  { key: 'dueDate', label: 'Дедлайн' },
  { key: 'linkedDocs', label: 'Документи' },
];
const WO_COLUMNS_DEFAULT_KEYS_JSON = JSON.stringify(WO_COLUMNS.map(c => c.key));

// Suspense обгортка для useSearchParams (Next.js static-export вимога).
// Inner-функція тримає всю логіку, default-export лише wrapper.
export default function WorkOrdersPage() {
  return (
    <Suspense fallback={null}>
      <WorkOrdersPageInner />
    </Suspense>
  );
}

function WorkOrdersPageInner() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT']);
  const queryClient = useQueryClient();
  const { employee } = useAuth();
  const router = useRouter();
  const { confirm, dialogProps: confirmDialogProps } = useConfirm();

  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    setNowMs(Date.now());
  }, []);

  const linkedNav = useLinkedNav();
  const linkedConfig = useMemo(() => workOrderLinkedConfig(linkedNav), [linkedNav]);

  // useListPage: shared table/panel/filter infrastructure
  const {
    page,
    setPage,
    resetPage,
    showDeleted,
    setShowDeleted,
    activeSavedFilterId,
    setActiveSavedFilterId,
    tableColumns: {
      visibleKeys: colVisible,
      visibleColumns,
      orderedColumns,
      order,
      customLabels,
      toggle: toggleCol,
      setVisible: setVisibleCols,
      reorder,
      renameColumn,
      resetConfig,
    },
    dragProps,
    detailPanel,
    panelConfig,
    savedFilters: { saved: savedFilters, save: saveFilter, remove: removeFilter },
    features,
    limit,
  } = useListPage<WOFilters>('work-orders', WO_COLUMNS, { defaultLimit: 20 });

  // Local filter state (specific to work-orders)
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [dateFrom, setDateFrom] = useState(() => kyivToday());
  const [dateTo, setDateTo] = useState(() => kyivToday());
  const { sort: woSort, toggle: toggleWoSort, set: setWoSort } = useSortState('createdAt', 'desc');
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

  // React Query hooks
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
    sortBy: woSort.sortBy,
    sortDir: woSort.sortDir,
  });
  // regression guard: fresh `[]` literal per render → useBulkSelect
  // effect fires on every render. Use module-level frozen EMPTY_ITEMS instead.
  const orders = queryData?.items ?? (EMPTY_ITEMS as unknown as WorkOrder[]);
  const total = queryData?.total ?? 0;

  // Modal & form state
  const [modal, setModal] = useState(false);
  const [modalPrefill, setModalPrefill] = useState<
    import('@/components/ui/CreateWorkOrderModal').CreateWOPrefill | undefined
  >();
  const [editWoId, setEditWoId] = useState<string | null>(null);
  const [linkedDocPopupId, setLinkedDocPopupId] = useState<string | null>(null);

  // Stable sorted ID list — prevents useQuery from refiring when React Query returns a
  // new array reference for identical data (e.g. background refetch with no changes).
  const ordersIds = useMemo(() => orders.map(o => o.id).sort(), [orders]);

  // useQuery gives dedup, stale-while-revalidate, and automatic invalidation when
  // workOrdersKeys.all is invalidated (key is nested under it). Replaces the manual
  // useEffect + setState approach that refired on every reference-stable React Query refresh.
  const { data: linkedCounts = EMPTY_LINKED_COUNTS } = useQuery<LinkedCountsMap>({
    queryKey: [...workOrdersKeys.all, 'linked-counts', ordersIds],
    queryFn: () =>
      apiFetch<LinkedCountsMap>('/work-orders/linked-counts', {
        method: 'POST',
        body: JSON.stringify({ workOrderIds: ordersIds }),
      }),
    enabled: ordersIds.length > 0,
    staleTime: 30_000,
  });

  // Escape closes the linked-documents popup. `onKeyDown` on overlay <div> не спрацьовує
  // без tabIndex/focus — потрібен глобальний listener (§14 a11y).
  useEffect(() => {
    if (!linkedDocPopupId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLinkedDocPopupId(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [linkedDocPopupId]);

  const searchParams = useSearchParams();

  const applyFilter = useCallback(
    (preset: SavedFilter<WOFilters>) => {
      setStatusFilter(preset.filters.statusFilter ?? '');
      setCategoryFilter(preset.filters.categoryFilter ?? '');
      setSearch(preset.filters.search ?? '');
      setShowDeleted(preset.filters.showDeleted ?? false);
      setMyOrders(preset.filters.myOrders ?? false);
      setDateFrom(preset.filters.dateFrom ?? '');
      setDateTo(preset.filters.dateTo ?? '');
      // View-частина подання: колонки + порядок + сортування (back-compat —
      // старі записи без цих полів не чіпають поточний вигляд).
      if (preset.order && preset.order.length > 0) reorder(preset.order);
      if (preset.columns && preset.columns.length > 0) setVisibleCols(preset.columns);
      if (preset.sort) setWoSort(preset.sort.field, preset.sort.dir);
      resetPage();
      setActiveSavedFilterId(preset.id);
    },
    [setShowDeleted, resetPage, setActiveSavedFilterId, reorder, setVisibleCols, setWoSort],
  );

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = saveFilter(
        name,
        {
          statusFilter,
          categoryFilter,
          search,
          showDeleted,
          myOrders,
          dateFrom,
          dateTo,
        },
        {
          columns: [...colVisible],
          order,
          sort: { field: woSort.sortBy, dir: woSort.sortDir },
        },
      );
      setActiveSavedFilterId(preset.id);
      if (features.toastEnabled) toast.success(`Подання "${name}" збережено`);
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
      colVisible,
      order,
      woSort.sortBy,
      woSort.sortDir,
      features.toastEnabled,
    ],
  );

  const { selectAllRef, ...bulkSelect } = useBulkIndeterminate(orders);

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
      // WEB-H1: перехід наряду (COMPLETED списує склад + CHARGE) → інвалідувати й інвентар,
      // і взаєморозрахунки, і звіти/дашборд, не лише список нарядів.
      invalidateWorkOrderSideEffects(queryClient);

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

  // sto-optimize: stable onClick для 11 StatusPill, інакше memo() не може пропустити
  // re-render бо inline arrow міняється кожного render.
  const handleSelectStatus = useCallback(
    (v: string) => {
      setStatusFilter(v);
      resetPage();
      setActiveSavedFilterId(null);
    },
    [resetPage, setActiveSavedFilterId],
  );

  // підтримка `?action=new` query — Command Palette + N shortcut + calendar prefill.
  useEffect(() => {
    if (searchParams?.get('action') !== 'new') return;
    const cpId = searchParams.get('counterpartyId');
    const vId = searchParams.get('vehicleId');
    const brId = searchParams.get('branchId');
    const desc = searchParams.get('description');
    setModalPrefill({
      counterpartyId: cpId ?? undefined,
      vehicleId: vId ?? undefined,
      branchId: brId ?? undefined,
      description: desc ?? undefined,
    });
    setModal(true);
    router.replace('/work-orders', { scroll: false });
  }, [searchParams, router]);

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

  // «Створити на основі»: бекенд POST /clone копіює позиції (роботи/запчастини)
  // у новий DRAFT-наряд із новим номером/датами. cloningId тримає id наряду, що
  // дублюється (для disabled + індикатора). Синхронний guard проти подвійного
  // кліку — через useSubmitGuard: `cloningId` (useState) оновлюється лише на
  // наступному ре-рендері, тож два синхронних кліки в ОДНОМУ tick обидва пройшли б
  // `if (cloningId) return` до перемалювання → 2 POST /clone (2 наряди-дублі).
  // Ref у guard фліпається синхронно (клас багів #630 / #632-636).
  const [cloningId, setCloningId] = useState<string | null>(null);
  const cloneGuard = useSubmitGuard();
  const handleClone = (wo: WorkOrder) =>
    cloneGuard.run(async () => {
      setCloningId(wo.id);
      try {
        const cloned = await apiFetch<{ id: string }>(`/work-orders/${wo.id}/clone`, {
          method: 'POST',
        });
        queryClient.invalidateQueries({ queryKey: workOrdersKeys.all });
        if (features.toastEnabled) toast.success('Наряд створено на основі');
        setEditWoId(cloned.id);
      } catch (e: unknown) {
        if (features.toastEnabled)
          toast.error(e instanceof Error ? e.message : 'Помилка дублювання');
      } finally {
        setCloningId(null);
      }
    });

  const totalPages = Math.ceil(total / limit);

  // sto-optimize: stable handler-references для DetailPanel — раніше inline
  // `() => setSelectedWO(null)` створювалось щоразу, що нівелює useMemo deps
  // для tabs/configFields/etc.
  const handleDetailPanelClose = useCallback(() => setSelectedWO(null), []);
  const handleOpenEdit = useCallback((id: string) => setEditWoId(id), []);

  // sto-optimize: extract IIFE → useMemo. Раніше блок `(() => { const buildWOTabs = ...; return <DetailPanel tabs={buildWOTabs(...)} ... /> })()`
  // виконувався на кожен render — `buildWOTabs` створювалась наново, потім
  // викликалась для побудови tabs-масиву + JSX. React Reconciler бачив новий
  // tabs-prop → DetailPanel/Badge/buildPanelFields обчислювались знову.
  // Тепер tabs обчислюються лише при зміні selectedWO/panelConfig.config/nowMs.
  const woDetailTabs = useMemo<DetailPanelTab[] | undefined>(() => {
    if (!selectedWO) return undefined;
    const wo = selectedWO;
    return [
      {
        key: 'info',
        label: 'Основне',
        content: (
          <div className="space-y-3">
            {buildPanelFields(wo, WORK_ORDER_PANEL_SCHEMA, panelConfig.config, {
              status: v => (
                <Badge
                  variant={STATUS_BADGE[String(v)] ?? 'secondary'}
                  dot
                  tooltip={STATUS_DESCRIPTIONS[String(v)]}
                >
                  {STATUS_LABELS[String(v)] ?? String(v)}
                </Badge>
              ),
              priority: v =>
                v ? (
                  <Badge variant={PRIORITY_BADGE[String(v)] ?? 'secondary'}>
                    {PRIORITY_LABELS[String(v)] ?? String(v)}
                  </Badge>
                ) : undefined,
              repairCategory: v => (v ? (CATEGORY_LABELS[String(v)] ?? String(v)) : undefined),
              dueDate: v =>
                v ? (
                  <span
                    className={cn(
                      'font-medium',
                      isOverdue(String(v), nowMs) ? 'text-warning' : undefined,
                    )}
                  >
                    {fmtDate(String(v))}
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
            <Button className="w-full" size="sm" onClick={() => handleOpenEdit(wo.id)}>
              Відкрити наряд
            </Button>
          </div>
        ),
      },
    ];
  }, [selectedWO, panelConfig.config, nowMs, handleOpenEdit]);

  const panelConfigFields = useMemo(
    () => schemaToPanelConfigFields(WORK_ORDER_PANEL_SCHEMA, panelConfig.config),
    [panelConfig.config],
  );

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Наряди</h1>
        </div>
      </div>

      {!modal && (error || queryError) && (
        <div className="mb-4 text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-4 py-2.5">
          {error || (queryError instanceof Error ? queryError.message : '')}
        </div>
      )}

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

      {/* Status filter pills + Мої наряди */}
      <div className="flex gap-1.5 flex-wrap items-center justify-between shrink-0">
        <div className="flex gap-1.5 flex-wrap items-center">
          {STATUS_TABS.map(([v, l]) => (
            <StatusPill
              key={v}
              value={v}
              label={l}
              active={statusFilter === v}
              description={STATUS_DESCRIPTIONS[v]}
              onSelect={handleSelectStatus}
            />
          ))}
        </div>
        {employee && (
          <button
            onClick={() => {
              setMyOrders(v => !v);
              resetPage();
              setActiveSavedFilterId(null);
            }}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium border transition-colors',
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

      {/* Search + category filter + showDeleted controls */}
      <div className="flex flex-wrap gap-3 shrink-0">
        <Input
          value={search}
          onChange={e => {
            setSearch(e.target.value);
            resetPage();
            setActiveSavedFilterId(null);
          }}
          placeholder="Пошук за номером або клієнтом..."
          leftElement={<Search />}
          className="w-72 h-8 text-[13px]"
        />
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-muted-foreground shrink-0">З</span>
          <DatePickerInput
            value={dateFrom}
            onChange={v => {
              setDateFrom(v);
              resetPage();
              setActiveSavedFilterId(null);
            }}
            max={dateTo || undefined}
            className="w-36"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-muted-foreground shrink-0">По</span>
          <DatePickerInput
            value={dateTo}
            onChange={v => {
              setDateTo(v);
              resetPage();
              setActiveSavedFilterId(null);
            }}
            min={dateFrom || undefined}
            className="w-36"
          />
        </div>

        <Select
          value={categoryFilter}
          onChange={e => {
            setCategoryFilter(e.target.value);
            resetPage();
            setActiveSavedFilterId(null);
          }}
          className="w-52 h-8 text-[13px] py-0.5 px-2 pr-7"
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
              resetPage();
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
              JSON.stringify(order) !== WO_COLUMNS_DEFAULT_KEYS_JSON ||
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
        <TableContainer>
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
                {visibleColumns.map(col => {
                  const sortable = ['documentDate', 'plannedAt', 'dueDate', 'amount'].includes(
                    col.key,
                  );
                  const sortKey = col.key === 'amount' ? 'totalAmount' : col.key;
                  if (sortable)
                    return (
                      <SortableHead
                        key={col.key}
                        sortKey={sortKey}
                        currentSort={woSort}
                        onSort={toggleWoSort}
                        className={col.key === 'amount' ? 'text-right' : undefined}
                        {...dragProps(col.key)}
                      >
                        {col.label}
                      </SortableHead>
                    );
                  return (
                    <TableHead key={col.key} {...dragProps(col.key)}>
                      {col.label}
                    </TableHead>
                  );
                })}
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
                orders.map((wo: WorkOrder) => {
                  const rowTone = rowStatusTone(
                    {
                      dueDate: wo.dueDate,
                      active: !WO_INACTIVE_STATUSES.has(wo.status),
                      balanceDue: (wo.totalAmount ?? 0) - (wo.paidAmount ?? 0),
                    },
                    nowMs,
                  );
                  const toneTitle = rowStatusLabel(rowTone);
                  return (
                    <TableRow
                      key={wo.id}
                      title={toneTitle}
                      onClick={() =>
                        detailPanel.enabled &&
                        setSelectedWO(prev => (prev?.id === wo.id ? null : wo))
                      }
                      className={cn(
                        'group transition-colors',
                        rowStatusBorderClass(rowTone),
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
                              <Badge
                                variant={STATUS_BADGE[wo.status] ?? 'secondary'}
                                dot
                                tooltip={STATUS_DESCRIPTIONS[wo.status]}
                              >
                                {STATUS_LABELS[wo.status] ?? wo.status}
                              </Badge>
                            </TableCell>
                          );
                        if (col.key === 'lift')
                          return (
                            <TableCell key="lift" className="text-[13px] text-muted-foreground">
                              {wo.liftName ?? '—'}
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
                        if (col.key === 'amount') {
                          // Plannedness check: actualHours рівні normoHours → suma нічого не «прокинула».
                          // totalParts однакові для actual та planned, тож порівнюємо лише labor-частку.
                          const hasActual = Math.abs(wo.totalActualLabor - wo.totalLabor) >= 0.01;
                          const plannedAmount = wo.totalLabor + wo.totalParts;
                          return (
                            <TableCell key="amount" className="tabular-nums text-right">
                              <div className="font-medium text-foreground">
                                {fmtMoney(wo.totalAmount)}
                              </div>
                              {hasActual && (
                                <div className="text-[11px] text-muted-foreground line-through">
                                  {fmtMoney(plannedAmount)}
                                </div>
                              )}
                            </TableCell>
                          );
                        }
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
                            <TableCell
                              key="plannedAt"
                              className="text-muted-foreground text-[12px]"
                            >
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
                                      {fmtDate(wo.dueDate)}
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </InlineViewCell>
                              )}
                            </TableCell>
                          );
                        if (col.key === 'linkedDocs') {
                          const counts = linkedCounts[wo.id];
                          return (
                            <TableCell key="linkedDocs" onClick={e => e.stopPropagation()}>
                              <div className="flex gap-1.5 items-center text-xs text-muted-foreground">
                                {DOC_COUNTERS.map(({ field, Icon, label }) => {
                                  const n = counts?.[field];
                                  if (!n) return null;
                                  return (
                                    <button
                                      key={field}
                                      onClick={() => setLinkedDocPopupId(wo.id)}
                                      className="flex items-center gap-0.5 hover:text-foreground transition-colors"
                                      title={`${label}: ${n}`}
                                    >
                                      <Icon size={13} />
                                      <span>{n}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            </TableCell>
                          );
                        }
                        return null;
                      })}
                      <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Відкрити наряд"
                            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            onClick={() => setEditWoId(wo.id)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          {!wo.deletedAt && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title="Створити на основі"
                              disabled={cloningId === wo.id}
                              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                              onClick={() => void handleClone(wo)}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          )}
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
                  );
                })}
            </TableBody>
          </Table>
        </TableContainer>

        <DetailPanel
          open={!!selectedWO && detailPanel.enabled}
          onClose={handleDetailPanelClose}
          title={selectedWO?.number ?? ''}
          tabs={woDetailTabs}
          configFields={panelConfigFields}
          onToggleField={panelConfig.toggleField}
          onReorderFields={panelConfig.reorderFields}
          onReset={panelConfig.reset}
        />
      </div>

      {/* Pagination */}
      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      <CreateWorkOrderModal
        open={modal}
        onClose={() => setModal(false)}
        prefill={modalPrefill}
        onCreated={wo => {
          queryClient.invalidateQueries({ queryKey: workOrdersKeys.all });
          setEditWoId(wo.id);
        }}
      />

      <CreateWorkOrderModal
        open={!!editWoId}
        onClose={() => setEditWoId(null)}
        workOrderId={editWoId ?? undefined}
        onUpdated={() => queryClient.invalidateQueries({ queryKey: workOrdersKeys.all })}
      />

      <ConfirmDialog {...confirmDialogProps} />

      {/* Linked documents popup. Escape handled by document-level listener above (§14 a11y). */}
      {linkedDocPopupId && (
        <div
          className="fixed inset-0 z-50 bg-black/30"
          onClick={() => setLinkedDocPopupId(null)}
          role="presentation"
        >
          <div
            className="absolute right-4 top-1/2 -translate-y-1/2 w-90 max-h-[80vh] overflow-y-auto bg-background rounded-xl shadow-2xl border border-border p-4"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Пов'язані документи наряду"
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-sm">Пов&apos;язані документи</h2>
              <button
                onClick={() => setLinkedDocPopupId(null)}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Закрити"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M1 1L13 13M13 1L1 13"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
            <LinkedDocumentsPanel config={linkedConfig} entityId={linkedDocPopupId} />
          </div>
        </div>
      )}
    </div>
  );
}
