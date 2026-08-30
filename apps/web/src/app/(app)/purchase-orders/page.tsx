'use client';

import { Suspense } from 'react';
import dynamic from 'next/dynamic';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useDebounce } from '@/hooks/useDebounce';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, ShoppingCart, Search, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import {
  usePurchaseOrders,
  purchaseOrdersKeys,
  PurchaseOrder,
} from '@/hooks/api/usePurchaseOrders';
import { EMPTY_ITEMS } from '@/hooks/api/usePaginatedList';
import { inventoryKeys } from '@/hooks/api/useInventory';
import { supplierPaymentsKeys } from '@/hooks/api/useSupplierPayments';
import { counterpartiesKeys } from '@/hooks/api/useCounterparties';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  PO_STATUS_LABELS,
  PO_STATUS_BADGE,
  PO_STATUS_DESCRIPTIONS,
  SUPPLIER_RETURN_STATUS_DESCRIPTIONS,
} from '@sto/shared';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pagination } from '@/components/ui/pagination';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { Input } from '@/components/ui/input';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
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
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { useBulkIndeterminate } from '@/hooks/useBulkIndeterminate';
import { useListPage } from '@/hooks/useListPage';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { PurchaseOrderCreateModal } from '@/components/ui/PurchaseOrderCreateModal';
// sto-optimize: SupplierReturnCreateModal — 856 LOC secondary action на сторінці
// /purchase-orders. Завантажується тільки при відкритті модального вікна
// (Створити SR / Редагувати SR). PO modal лишається eager — це primary action.
const SupplierReturnCreateModal = dynamic(
  () =>
    import('@/components/ui/SupplierReturnCreateModal').then(m => ({
      default: m.SupplierReturnCreateModal,
    })),
  { ssr: false },
);
import {
  useSupplierReturns,
  useDeleteSupplierReturn,
  type SupplierReturn,
} from '@/hooks/api/useSupplierReturns';
import {
  SUPPLIER_RETURN_STATUS_LABELS,
  SUPPLIER_RETURN_STATUS_BADGE,
  type BadgeVariant,
} from '@sto/shared';
import { toast } from '@/lib/toast';
import { cn, UUID_RE, daysUntil } from '@/lib/utils';
import { fmtMoney, fmtDate, kyivToday } from '@/lib/format';
import { StatusPill } from '@/components/ui/status-pill';
import { ExpiryBadge } from '@/components/ui/expiry-badge';

// Module-level formatter — produces YYYY-MM-DD in Kyiv local time (DST-aware).

interface PoFilters extends Record<string, unknown> {
  status: string;
  q: string;
  showDeleted: boolean;
  dateFrom: string;
  dateTo: string;
}

const STATUS_LABELS = PO_STATUS_LABELS;
const STATUS_BADGE = PO_STATUS_BADGE;

function fmt(n: number) {
  return fmtMoney(n) + ' ₴';
}

// Module-level — статичні колонки + прекомпьютений JSON для hasCustomization.
const COLUMNS: Array<{ key: string; label: string; defaultVisible?: boolean }> = [
  { key: 'number', label: 'Номер', defaultVisible: true },
  { key: 'supplier', label: 'Постачальник', defaultVisible: true },
  { key: 'warehouse', label: 'Склад', defaultVisible: true },
  { key: 'status', label: 'Статус', defaultVisible: true },
  { key: 'amount', label: 'Сума', defaultVisible: true },
  { key: 'date', label: 'Дата документа', defaultVisible: true },
  { key: 'paymentDate', label: 'Дата оплати', defaultVisible: true },
  { key: 'payDue', label: 'Днів до оплати', defaultVisible: true },
  { key: 'priced', label: 'Розцінено', defaultVisible: true },
];
const COLUMNS_DEFAULT_KEYS_JSON = JSON.stringify(COLUMNS.map(c => c.key));

const COLUMNS_SR: Array<{ key: string; label: string; defaultVisible?: boolean }> = [
  { key: 'number', label: 'Номер', defaultVisible: true },
  { key: 'supplier', label: 'Постачальник', defaultVisible: true },
  { key: 'warehouse', label: 'Склад', defaultVisible: true },
  { key: 'status', label: 'Статус', defaultVisible: true },
  { key: 'amount', label: 'Сума', defaultVisible: true },
  { key: 'date', label: 'Дата документа', defaultVisible: true },
];
const COLUMNS_SR_DEFAULT_KEYS_JSON = JSON.stringify(COLUMNS_SR.map(c => c.key));

// Опції фільтра статусу — повністю статичні (PO_STATUS_LABELS — імпортована константа).
// Раніше створювались у тілі компонента на кожен render разом з рядками StatusPill.
const PO_STATUS_FILTER_OPTIONS: Array<[string, string]> = [
  ['', 'Всі'],
  ['DRAFT', PO_STATUS_LABELS['DRAFT']],
  ['ORDERED', PO_STATUS_LABELS['ORDERED']],
  ['PARTIAL', PO_STATUS_LABELS['PARTIAL']],
  ['RECEIVED', PO_STATUS_LABELS['RECEIVED']],
  ['CANCELLED', PO_STATUS_LABELS['CANCELLED']],
];

interface SrFilters extends Record<string, unknown> {
  status: string;
  q: string;
  showDeleted: boolean;
  dateFrom: string;
  dateTo: string;
}

type PurchaseTab = 'orders' | 'returns';

function PurchaseOrdersPageClient() {
  useRequireAuth(['OWNER', 'ADMIN', 'STOREKEEPER']);

  const searchParams = useSearchParams();
  const router = useRouter();
  const activeTab: PurchaseTab = searchParams.get('tab') === 'returns' ? 'returns' : 'orders';
  const setActiveTab = useCallback(
    (tab: PurchaseTab) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', tab);
      // scroll: false — keep current scroll position (otherwise switching tabs scrolls
      // page-fill container to top, which is jarring in long lists).
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const queryClient = useQueryClient();
  const { confirm, dialogProps } = useConfirm();

  // Прийом PO (receive) має побічні ефекти на кількох агрегатах: RECEIPT-рух →
  // inventory (залишки); settlement CHARGE + авто paymentDate → supplier-payments
  // (шахматка) і counterparties (баланс). Інвалідуємо всі одразу, щоб не чекати 30s
  // staleTime. Єдине місце правди — викликається з receive-handler і edit-modal onSaved.
  const invalidatePoReceiptCaches = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
    queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
    queryClient.invalidateQueries({ queryKey: supplierPaymentsKeys.all });
    queryClient.invalidateQueries({ queryKey: counterpartiesKeys.all });
  }, [queryClient]);

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
      reorder,
      renameColumn,
      resetConfig,
    },
    dragProps,
    savedFilters: { saved: savedFilters, save: saveFilter, remove: removeFilter },
    features,
    limit,
  } = useListPage<PoFilters>('purchase-orders', COLUMNS, { defaultLimit: 20 });

  // Local filter state (specific to purchase-orders)
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q);
  const [error, setError] = useState('');
  const [dateFrom, setDateFrom] = useState(() => kyivToday());
  const [dateTo, setDateTo] = useState(() => kyivToday());
  const { sort: poSort, toggle: togglePoSort } = useSortState('createdAt', 'desc');

  // SSR-safe «сьогодні» для бейджа «Днів до оплати» (уникає hydration mismatch).
  const [today, setToday] = useState<Date | null>(null);
  useEffect(() => setToday(new Date()), []);

  // React Query hooks
  const {
    data: queryData,
    isLoading: loading,
    error: queryError,
  } = usePurchaseOrders({
    page,
    limit,
    status,
    q: debouncedQ,
    showDeleted,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    sortBy: poSort.sortBy,
    sortDir: poSort.sortDir,
  });
  // regression guard — stable empty array reference.
  const orders = queryData?.items ?? (EMPTY_ITEMS as unknown as PurchaseOrder[]);
  const total = queryData?.total ?? 0;
  const totalPages = Math.ceil(total / limit) || 1;

  const { selectAllRef, ...bulkSelect } = useBulkIndeterminate(orders);

  const applyFilter = useCallback(
    (preset: { id: string; filters: PoFilters }) => {
      setStatus(preset.filters.status ?? '');
      setQ(preset.filters.q ?? '');
      setShowDeleted(preset.filters.showDeleted ?? false);
      setDateFrom(preset.filters.dateFrom ?? '');
      setDateTo(preset.filters.dateTo ?? '');
      resetPage();
      setActiveSavedFilterId(preset.id);
    },
    [resetPage, setActiveSavedFilterId],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = saveFilter(name, { status, q, showDeleted, dateFrom, dateTo });
      setActiveSavedFilterId(preset.id);
      if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
    },
    [
      saveFilter,
      status,
      q,
      showDeleted,
      dateFrom,
      dateTo,
      features.toastEnabled,
      setActiveSavedFilterId,
    ],
  );

  // Unsaved guard for create/receive modals
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  // Modal & form state
  const [showCreate, setShowCreate] = useState(false);
  const [editingPOId, setEditingPOId] = useState<string | null>(null);
  const [showReceive, setShowReceive] = useState<PurchaseOrder | null>(null);

  // Bug #596: deep-link `?open=<poId>` — відкриває edit-modal для конкретного PO
  // (напр. з /supplier-payments/[id] «покажи замовлення»). Читаємо ОДНОРАЗОВО з URL,
  // очищуємо параметр щоб refresh не спамив модалку, і на mount якщо UUID валідний —
  // виставляємо editingPOId. Дзеркалить URL-driven pattern активної вкладки (line 134).
  useEffect(() => {
    const openId = searchParams.get('open');
    if (openId && UUID_RE.test(openId)) {
      setEditingPOId(openId);
      const params = new URLSearchParams(searchParams.toString());
      params.delete('open');
      router.replace(params.toString() ? `?${params.toString()}` : '?', { scroll: false });
    }
    // Свідомо без залежності від searchParams: ефект має спрацювати РАЗ при монтуванні
    // (deep-link з зовнішньої сторінки). Наступні пуші тієї ж сторінки — не reopen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Supplier returns — useListPage (columns, detail-panel, saved-filters)
  const {
    page: srPage,
    setPage: setSrPage,
    resetPage: resetSrPage,
    showDeleted: srShowDeleted,
    setShowDeleted: setSrShowDeleted,
    activeSavedFilterId: srActiveSavedFilterId,
    setActiveSavedFilterId: setSrActiveSavedFilterId,
    tableColumns: {
      visibleKeys: srColVisible,
      visibleColumns: srVisibleColumns,
      orderedColumns: srOrderedColumns,
      order: srOrder,
      customLabels: srCustomLabels,
      toggle: toggleSrCol,
      reorder: reorderSr,
      renameColumn: renameSrColumn,
      resetConfig: resetSrConfig,
    },
    dragProps: srDragProps,
    savedFilters: { saved: srSavedFilters, save: saveSrFilter, remove: removeSrFilter },
    features: srFeatures,
    limit: srLimit,
  } = useListPage<SrFilters>('supplier-returns', COLUMNS_SR, { defaultLimit: 50 });

  // Supplier returns filter state
  const [srSearch, setSrSearch] = useState('');
  const debouncedSrSearch = useDebounce(srSearch);
  const [srStatus, setSrStatus] = useState('');
  const [srDateFrom, setSrDateFrom] = useState(() => kyivToday());
  const [srDateTo, setSrDateTo] = useState(() => kyivToday());
  const [srCreateOpen, setSrCreateOpen] = useState(false);
  const [srEditId, setSrEditId] = useState<string | null>(null);

  const handleSaveSrFilter = useCallback(
    (name: string) => {
      const preset = saveSrFilter(name, {
        status: srStatus,
        q: srSearch,
        showDeleted: srShowDeleted,
        dateFrom: srDateFrom,
        dateTo: srDateTo,
      });
      setSrActiveSavedFilterId(preset.id);
      if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
    },
    [
      saveSrFilter,
      srStatus,
      srSearch,
      srShowDeleted,
      srDateFrom,
      srDateTo,
      features.toastEnabled,
      setSrActiveSavedFilterId,
    ],
  );

  const { data: srData, isLoading: srLoading } = useSupplierReturns({
    q: debouncedSrSearch,
    status: srStatus,
    showDeleted: srShowDeleted,
    dateFrom: srDateFrom || undefined,
    dateTo: srDateTo || undefined,
    page: srPage,
    limit: srLimit,
  });
  const srItems = srData?.items ?? ([] as SupplierReturn[]);
  const deleteSupplierReturn = useDeleteSupplierReturn();

  const [saving, setSaving] = useState(false);

  const [receiveLines, setReceiveLines] = useState<{ lineId: string; receivedQty: string }[]>([]);

  interface PricingResult {
    updated: number;
    details: {
      goodId: string;
      goodName: string;
      costPrice: number;
      oldSalePrice: number;
      newSalePrice: number;
    }[];
  }
  const [pricingResult, setPricingResult] = useState<Record<string, PricingResult>>({});

  const bulkDeleteSelected = useCallback(
    async (ids: string[]) => {
      if (
        !(await confirm({
          title: `Видалити ${ids.length} замовлень?`,
          confirmLabel: 'Видалити',
          variant: 'destructive',
        }))
      )
        return;
      const results = await Promise.allSettled(
        ids.map(id => apiFetch(`/purchase-orders/${id}`, { method: 'DELETE' })),
      );
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.length - succeeded;
      bulkSelect.clear();
      queryClient.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
      if (features.toastEnabled) {
        if (succeeded > 0 && failed === 0) toast.success(`Видалено ${succeeded} замовлень`);
        else if (succeeded > 0)
          toast.warning(`Видалено ${succeeded} з ${results.length}. ${failed} не вдалось`);
        else toast.error('Не вдалося видалити замовлення');
      }
    },
    [confirm, bulkSelect, features.toastEnabled, queryClient],
  );

  const bulkActions = useMemo<BulkAction[]>(
    () => [
      {
        id: 'delete',
        label: 'Видалити вибрані',
        variant: 'destructive',
        onClick: bulkDeleteSelected,
      },
    ],
    [bulkDeleteSelected],
  );

  const markDeleted = useCallback(
    async (po: PurchaseOrder) => {
      if (
        !(await confirm({
          title: `Позначити замовлення ${po.number} на видалення?`,
          variant: 'destructive',
        }))
      )
        return;
      try {
        await apiFetch(`/purchase-orders/${po.id}`, { method: 'DELETE' });
        queryClient.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
        toast.success('Замовлення позначено на видалення');
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : 'Помилка видалення');
      }
    },
    [confirm, queryClient],
  );

  const openReceiveWithLines = useCallback((po: PurchaseOrder) => {
    setReceiveLines(po.lines.map(l => ({ lineId: l.id!, receivedQty: '' })));
    setShowReceive(po);
  }, []);

  const openReceive = useCallback(
    async (po: PurchaseOrder) => {
      // Lines are not included in list response — fetch full PO on demand
      if (po.lines.length > 0 || po.linesCount === 0) {
        openReceiveWithLines(po);
        return;
      }
      try {
        const full = await apiFetch<PurchaseOrder>(`/purchase-orders/${po.id}`);
        openReceiveWithLines(full);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Не вдалось завантажити позиції');
      }
    },
    [openReceiveWithLines],
  );

  const handleReceive = async () => {
    if (!showReceive) return;
    const receivedLines = receiveLines
      .filter(l => parseFloat(l.receivedQty) > 0)
      .map(l => ({ lineId: l.lineId, receivedQty: parseFloat(l.receivedQty) }));
    if (!receivedLines.length) {
      setError('Вкажіть кількість для хоча б однієї позиції');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await apiFetch<PurchaseOrder>(`/purchase-orders/${showReceive.id}/receive`, {
        method: 'POST',
        body: JSON.stringify({ lines: receivedLines }),
      });
      setShowReceive(null);
      dirty.resetDirty();
      invalidatePoReceiptCaches();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка прийому товару');
    } finally {
      setSaving(false);
    }
  };

  const statuses = PO_STATUS_FILTER_OPTIONS;

  return (
    <div className="page-fill p-4 md:p-6">
      {(error || queryError) && (
        <div className="mb-4 text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error || (queryError instanceof Error ? queryError.message : '')}
        </div>
      )}
      <div className="page-header">
        <div>
          <h1 className="page-title">Купівля</h1>
        </div>
      </div>

      {/* Section tabs */}
      <div className="shrink-0 flex gap-0 border-b border-border -mx-6 px-6 overflow-x-auto">
        {(
          [
            { key: 'orders', label: 'Замовлення постачальникам' },
            { key: 'returns', label: 'Повернення постачальнику' },
          ] as const
        ).map(tab => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:rounded-sm',
              activeTab === tab.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'returns' && (
        <div className="flex flex-col gap-3 flex-1">
          {/* Saved filters */}
          {srFeatures.savedFiltersEnabled && (
            <SavedFiltersBar<SrFilters>
              saved={srSavedFilters}
              activeId={srActiveSavedFilterId}
              onApply={preset => {
                setSrStatus(preset.filters.status ?? '');
                setSrSearch(preset.filters.q ?? '');
                setSrShowDeleted(preset.filters.showDeleted ?? false);
                setSrDateFrom(preset.filters.dateFrom ?? '');
                setSrDateTo(preset.filters.dateTo ?? '');
                resetSrPage();
                setSrActiveSavedFilterId(preset.id);
              }}
              onSave={handleSaveSrFilter}
              onRemove={removeSrFilter}
              hideSaveButton
            />
          )}

          {/* Status filter chips */}
          <div className="flex flex-wrap gap-1.5 shrink-0">
            {(['', 'DRAFT', 'CONFIRMED', 'CANCELLED'] as const).map(s => (
              <StatusPill
                key={s}
                value={s}
                label={s ? SUPPLIER_RETURN_STATUS_LABELS[s] : 'Всі'}
                active={srStatus === s}
                description={s ? SUPPLIER_RETURN_STATUS_DESCRIPTIONS[s] : undefined}
                onSelect={v => {
                  setSrStatus(v);
                  resetSrPage();
                  setSrActiveSavedFilterId(null);
                }}
              />
            ))}
          </div>

          {/* Returns toolbar */}
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <Input
              value={srSearch}
              onChange={e => {
                setSrSearch(e.target.value);
                resetSrPage();
                setSrActiveSavedFilterId(null);
              }}
              placeholder="Пошук за номером, постачальником..."
              leftElement={<Search />}
              className="w-64 h-8 text-[13px]"
            />
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-muted-foreground shrink-0">З</span>
              <DatePickerInput
                value={srDateFrom}
                onChange={v => {
                  setSrDateFrom(v);
                  resetSrPage();
                  setSrActiveSavedFilterId(null);
                }}
                max={srDateTo || undefined}
                className="w-36"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-muted-foreground shrink-0">По</span>
              <DatePickerInput
                value={srDateTo}
                onChange={v => {
                  setSrDateTo(v);
                  resetSrPage();
                  setSrActiveSavedFilterId(null);
                }}
                min={srDateFrom || undefined}
                className="w-36"
              />
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Button
                variant="outline"
                size="icon-sm"
                title={srShowDeleted ? 'Сховати видалені' : 'Показати видалені'}
                onClick={() => {
                  setSrShowDeleted(v => !v);
                  resetSrPage();
                  setSrActiveSavedFilterId(null);
                }}
                className={cn(srShowDeleted && 'border-primary text-primary')}
              >
                {srShowDeleted ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </Button>
              {srFeatures.savedFiltersEnabled && <SaveFilterButton onSave={handleSaveSrFilter} />}
              <ColumnsDropdown
                columns={srOrderedColumns}
                visibleKeys={srColVisible}
                onToggle={toggleSrCol}
                onReorder={reorderSr}
                onRename={renameSrColumn}
                onReset={resetSrConfig}
                hasCustomization={
                  JSON.stringify(srOrder) !== COLUMNS_SR_DEFAULT_KEYS_JSON ||
                  Object.keys(srCustomLabels).length > 0
                }
              />
              {/* Bug #505: DetailPanelToggle видалено — для returns tab ніколи не існувало DetailPanel. */}
              <Button
                onClick={() => {
                  setSrEditId(null);
                  setSrCreateOpen(true);
                }}
                leftIcon={<Plus className="h-4 w-4" />}
              >
                Повернення
              </Button>
            </div>
          </div>

          {/* Returns table */}
          <div className="flex flex-1 min-h-0">
            <div className="table-scroll-container flex-1 min-h-0 min-w-0 overflow-auto bg-surface border border-border rounded-xl">
              <Table>
                <TableHeader>
                  <TableRow>
                    {srVisibleColumns.map(col => (
                      <TableHead
                        key={col.key}
                        className={col.key === 'amount' ? 'text-right' : undefined}
                        {...srDragProps(col.key)}
                      >
                        {col.label}
                      </TableHead>
                    ))}
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {srLoading && (
                    <TableRow>
                      <TableCell
                        colSpan={srVisibleColumns.length + 1}
                        className="py-10 text-center"
                      >
                        <div className="flex justify-center">
                          <Spinner size="md" />
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                  {!srLoading && srItems.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={srVisibleColumns.length + 1} className="p-0">
                        <EmptyState
                          icon={ShoppingCart}
                          title="Повернень не знайдено"
                          action={
                            <Button
                              size="sm"
                              onClick={() => {
                                setSrEditId(null);
                                setSrCreateOpen(true);
                              }}
                            >
                              <Plus className="mr-1 h-4 w-4" />
                              Повернення
                            </Button>
                          }
                        />
                      </TableCell>
                    </TableRow>
                  )}
                  {!srLoading &&
                    srItems.map(sr => (
                      <TableRow
                        key={sr.id}
                        className="group transition-colors cursor-pointer"
                        onClick={() => {
                          setSrEditId(sr.id);
                          setSrCreateOpen(true);
                        }}
                      >
                        {srVisibleColumns.map(col => {
                          if (col.key === 'number')
                            return (
                              <TableCell key="number" className="font-medium text-[13px]">
                                {sr.number}
                              </TableCell>
                            );
                          if (col.key === 'supplier')
                            return (
                              <TableCell key="supplier" className="text-[13px]">
                                {sr.supplierName ?? '—'}
                              </TableCell>
                            );
                          if (col.key === 'warehouse')
                            return (
                              <TableCell
                                key="warehouse"
                                className="text-[13px] text-muted-foreground"
                              >
                                {sr.warehouseName ?? '—'}
                              </TableCell>
                            );
                          if (col.key === 'status')
                            return (
                              <TableCell key="status">
                                <Badge
                                  variant={SUPPLIER_RETURN_STATUS_BADGE[sr.status] as BadgeVariant}
                                  tooltip={SUPPLIER_RETURN_STATUS_DESCRIPTIONS[sr.status]}
                                >
                                  {SUPPLIER_RETURN_STATUS_LABELS[sr.status] ?? sr.status}
                                </Badge>
                              </TableCell>
                            );
                          if (col.key === 'amount')
                            return (
                              <TableCell
                                key="amount"
                                className="text-right tabular-nums text-[13px]"
                              >
                                {fmtMoney(sr.totalAmount)}
                              </TableCell>
                            );
                          if (col.key === 'date')
                            return (
                              <TableCell key="date" className="text-[13px] text-muted-foreground">
                                {sr.documentDate ? fmtDate(sr.documentDate) : '—'}
                              </TableCell>
                            );
                          return null;
                        })}
                        <TableCell className="w-16" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                            <button
                              type="button"
                              className="rounded p-1 text-muted-foreground hover:bg-surface-hover hover:text-foreground"
                              title="Відкрити"
                              aria-label={`Відкрити повернення ${sr.number}`}
                              onClick={() => {
                                setSrEditId(sr.id);
                                setSrCreateOpen(true);
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            {sr.status === 'DRAFT' && (
                              <button
                                type="button"
                                className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                                title="Видалити"
                                aria-label={`Видалити повернення ${sr.number}`}
                                disabled={
                                  deleteSupplierReturn.isPending &&
                                  deleteSupplierReturn.variables === sr.id
                                }
                                onClick={async e => {
                                  e.stopPropagation();
                                  // без try/catch throw з mutateAsync → silent failure
                                  // (TanStack Query не має глобального MutationCache.onError у проекті).
                                  try {
                                    await deleteSupplierReturn.mutateAsync(sr.id);
                                    if (features.toastEnabled) toast.success('Повернення видалено');
                                  } catch (err: unknown) {
                                    toast.error(
                                      err instanceof Error ? err.message : 'Не вдалось видалити',
                                    );
                                  }
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'orders' && (
        <div className="flex flex-col gap-3 flex-1">
          {/* Saved filters */}
          {features.savedFiltersEnabled && (
            <SavedFiltersBar<PoFilters>
              saved={savedFilters}
              activeId={activeSavedFilterId}
              onApply={applyFilter}
              onSave={handleSaveFilter}
              onRemove={removeFilter}
              hideSaveButton
            />
          )}

          {/* Status filters */}
          <div className="flex flex-wrap gap-1.5 shrink-0">
            {statuses.map(([v, l]) => (
              <StatusPill
                key={v}
                value={v}
                label={l}
                active={status === v}
                description={v ? PO_STATUS_DESCRIPTIONS[v] : undefined}
                onSelect={v => {
                  setStatus(v);
                  resetPage();
                  setActiveSavedFilterId(null);
                }}
              />
            ))}
          </div>

          {/* Filters row */}
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <Input
              value={q}
              onChange={e => {
                setQ(e.target.value);
                resetPage();
                setActiveSavedFilterId(null);
              }}
              placeholder="Пошук за номером, постачальником..."
              leftElement={<Search />}
              className="w-64 h-8 text-[13px]"
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
                  JSON.stringify(order) !== COLUMNS_DEFAULT_KEYS_JSON ||
                  Object.keys(customLabels).length > 0
                }
              />
              {/* Bug #505: DetailPanelToggle видалено — DetailPanel було видалено у Bug #496 fix, toggle лишився без consumer-а. */}
              <Button onClick={() => setShowCreate(true)} leftIcon={<Plus className="h-4 w-4" />}>
                Замовлення
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
            <div className="table-scroll-container flex-1 min-h-0 min-w-0 overflow-auto bg-surface border border-border rounded-xl">
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
                      const sortable = ['date', 'amount', 'paymentDate'].includes(col.key);
                      const sortKey =
                        col.key === 'date'
                          ? 'documentDate'
                          : col.key === 'amount'
                            ? 'totalAmount'
                            : col.key;
                      if (sortable)
                        return (
                          <SortableHead
                            key={col.key}
                            sortKey={sortKey}
                            currentSort={poSort}
                            onSort={togglePoSort}
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
                        className="py-10 text-center"
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
                        <EmptyState icon={ShoppingCart} title="Замовлень не знайдено" />
                      </TableCell>
                    </TableRow>
                  )}
                  {!loading &&
                    orders.map(po => (
                      <TableRow
                        key={po.id}
                        className={cn(
                          'group transition-colors cursor-pointer',
                          bulkSelect.isSelected(po.id) && 'bg-primary/5',
                          po.deletedAt && 'opacity-60',
                        )}
                        onClick={() => {
                          setEditingPOId(po.id);
                        }}
                      >
                        {features.bulkActionsEnabled && (
                          <TableCell className="w-9 pr-0" onClick={e => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={bulkSelect.isSelected(po.id)}
                              onChange={() => bulkSelect.toggle(po.id)}
                              className="h-3.5 w-3.5 rounded border-border"
                              aria-label={`Вибрати замовлення ${po.number}`}
                            />
                          </TableCell>
                        )}
                        {visibleColumns.map(col => {
                          if (col.key === 'number')
                            return (
                              <TableCell key="number" className="font-medium text-[13px]">
                                {po.number}
                                {po.deletedAt && (
                                  <Badge
                                    variant="destructive"
                                    className="ml-2 text-[10px] px-1 py-0"
                                  >
                                    видалено
                                  </Badge>
                                )}
                              </TableCell>
                            );
                          if (col.key === 'supplier')
                            return (
                              <TableCell key="supplier" className="text-[13px]">
                                {po.supplierName ?? '—'}
                              </TableCell>
                            );
                          if (col.key === 'warehouse')
                            return (
                              <TableCell
                                key="warehouse"
                                className="text-[13px] text-muted-foreground"
                              >
                                {po.warehouseName ?? '—'}
                              </TableCell>
                            );
                          if (col.key === 'status')
                            return (
                              <TableCell key="status">
                                <Badge
                                  variant={STATUS_BADGE[po.status] ?? 'secondary'}
                                  tooltip={PO_STATUS_DESCRIPTIONS[po.status]}
                                >
                                  {STATUS_LABELS[po.status]}
                                </Badge>
                              </TableCell>
                            );
                          if (col.key === 'amount')
                            return (
                              <TableCell
                                key="amount"
                                className="text-right font-semibold text-[13px]"
                              >
                                {fmtMoney(po.totalAmount)} ₴
                              </TableCell>
                            );
                          if (col.key === 'date')
                            return (
                              <TableCell key="date" className="text-[13px] text-muted-foreground">
                                {po.documentDate ? fmtDate(po.documentDate) : fmtDate(po.createdAt)}
                              </TableCell>
                            );
                          if (col.key === 'paymentDate')
                            return (
                              <TableCell
                                key="paymentDate"
                                className="text-[13px] text-muted-foreground"
                              >
                                {po.paymentDate ? fmtDate(po.paymentDate) : '—'}
                              </TableCell>
                            );
                          if (col.key === 'payDue') {
                            // Бейдж лише де є реальний залишок боргу по PO.
                            const dpd =
                              (po.outstanding ?? 0) > 0
                                ? daysUntil(po.paymentDate, today?.getTime() ?? 0)
                                : null;
                            return (
                              <TableCell key="payDue" className="text-[13px]">
                                {dpd != null && (
                                  <ExpiryBadge
                                    date={po.paymentDate}
                                    nowMs={today?.getTime() ?? 0}
                                    expiredLabel={`Прострочено ${Math.abs(dpd)} дн.`}
                                    soonLabel={`${dpd} дн.`}
                                    soonDays={20}
                                  />
                                )}
                              </TableCell>
                            );
                          }
                          if (col.key === 'priced')
                            return (
                              <TableCell key="priced" className="text-[13px]">
                                {po.pricedAt ? (
                                  <span className="text-success font-medium">Так</span>
                                ) : (
                                  <span className="text-muted-foreground">Ні</span>
                                )}
                              </TableCell>
                            );
                          return null;
                        })}
                        <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              title="Редагувати"
                              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                              onClick={() => setEditingPOId(po.id)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            {!po.deletedAt && (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                title="Позначити на видалення"
                                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                                onClick={() => void markDeleted(po)}
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

            {/* DetailPanel removed — selection-state was never wired (Bug #496);
               row click opens Edit modal via setEditingPOId. */}
          </div>

          {/* Pagination */}
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </div>
      )}

      {/* Create modal */}
      <PurchaseOrderCreateModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSaved={() => {
          setShowCreate(false);
          queryClient.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
        }}
      />

      {/* Edit modal — відкривається при кліку на рядок */}
      <PurchaseOrderCreateModal
        open={!!editingPOId}
        purchaseOrderId={editingPOId ?? undefined}
        onClose={() => setEditingPOId(null)}
        onSaved={invalidatePoReceiptCaches}
      />

      {/* Receive modal */}
      <Modal
        open={!!showReceive}
        onClose={async () => {
          if (!(await dirty.confirmClose())) return;
          setShowReceive(null);
          dirty.resetDirty();
        }}
        title={showReceive ? `Прийом по замовленню ${showReceive.number}` : ''}
        size="lg"
        footer={
          <Button onClick={handleReceive} loading={saving} className="w-full">
            Підтвердити прийом
          </Button>
        }
      >
        {showReceive && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Вкажіть кількість, яку фактично отримано по кожній позиції
            </p>
            <div className="space-y-3">
              {showReceive.lines.map((line, i) => (
                <div
                  key={line.id ?? i}
                  className="flex items-center gap-3 p-3 bg-secondary rounded-lg"
                >
                  <div className="flex-1">
                    <div className="text-sm font-medium text-foreground">{line.goodName}</div>
                    <div className="text-xs text-muted-foreground">
                      Замовлено: {line.quantity} {line.unitShortName ?? line.unit} · Отримано
                      раніше: {line.receivedQty ?? 0}
                    </div>
                  </div>
                  <Input
                    type="number"
                    value={receiveLines[i]?.receivedQty ?? ''}
                    onChange={e => {
                      setReceiveLines(ls =>
                        ls.map((l, idx) => (idx === i ? { ...l, receivedQty: e.target.value } : l)),
                      );
                      dirty.markDirty();
                    }}
                    placeholder={`макс. ${line.quantity - (line.receivedQty ?? 0)}`}
                    min="0"
                    max={line.quantity - (line.receivedQty ?? 0)}
                    step="0.001"
                    className="w-28 text-right h-8 text-[13px]"
                  />
                  <span className="text-xs text-muted-foreground">
                    {line.unitShortName ?? line.unit}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>
      <DirtyConfirmDialog {...dirty.dialogProps} />
      <ConfirmDialog {...dialogProps} />

      {/* Supplier returns modal */}
      <SupplierReturnCreateModal
        open={srCreateOpen}
        onClose={() => {
          setSrCreateOpen(false);
          setSrEditId(null);
        }}
        onSaved={() => {
          setSrCreateOpen(false);
          setSrEditId(null);
        }}
        editId={srEditId}
      />
    </div>
  );
}

export default function PurchaseOrdersPage() {
  return (
    <Suspense fallback={null}>
      <PurchaseOrdersPageClient />
    </Suspense>
  );
}
