'use client';

import { Suspense, useState, useCallback, useMemo, useEffect } from 'react';
import type { ElementType } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams, useRouter } from 'next/navigation';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import {
  useStockDocuments,
  stockDocsKeys,
  type StockDoc,
  type StockDocStatusValue,
} from '@/hooks/api/useStockDocuments';
import { EMPTY_ITEMS } from '@/hooks/api/usePaginatedList';
import {
  Plus,
  FileText,
  Eye,
  EyeOff,
  Trash2,
  Pencil,
  ClipboardList,
  Warehouse,
} from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { StockMovementsTab } from './StockMovementsTab';
import { apiFetch } from '@/lib/api-client';
import { LinkedDocumentsPanel } from '@/components/ui/LinkedDocumentsPanel';
import { LinkedDocumentsPopup } from '@/components/ui/LinkedDocumentsPopup';
import { stockDocumentLinkedConfig } from '@/lib/linked-configs';
import { useLinkedNav } from '@/lib/linked-nav';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  STOCK_DOC_TYPE_LABELS,
  STOCK_DOC_TYPE_BADGE,
  STOCK_DOC_TYPE_DESCRIPTIONS,
  STOCK_DOC_STATUS_LABELS,
  STOCK_DOC_STATUS_BADGE,
  STOCK_DOC_STATUS_DESCRIPTIONS,
} from '@sto/shared';
import { stockDocTypeLabel, stockDocStatusLabel } from '@/i18n/enumLabel';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pagination } from '@/components/ui/pagination';
import { useConfirm } from '@/hooks/useConfirm';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { StockDocumentCreateModal } from '@/components/ui/StockDocumentCreateModal';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
// Row click веде в edit modal через setEditingDocId — це реальний flow для перегляду документа.
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
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { useListPage } from '@/hooks/useListPage';
import { useBulkIndeterminate } from '@/hooks/useBulkIndeterminate';
import { toast } from '@/lib/toast';
import { invalidateStockDocumentSideEffects } from '@/lib/cache-invalidation';
import { cn, UUID_RE } from '@/lib/utils';
import { fmtDate, fmtDateTime, fmtMoney, kyivToday } from '@/lib/format';
import { StatusPill } from '@/components/ui/status-pill';

// Module-level formatter — produces YYYY-MM-DD in Kyiv local time (DST-aware).

// StockDoc/DocLine більше НЕ оголошуються тут: були локальною копією
// StockDocumentResponseDto (слабшою — `type`/`status` як `string`, без orgId
// і purchaseOrder*). Тип береться з хука, який бере його зі згенерованого
// api-types — docs/PATTERNS.md, «Типи API: беремо згенероване».

interface StockDocFilters extends Record<string, unknown> {
  typeFilter: string;
  statusFilter: string;
  showDeleted: boolean;
  dateFrom: string;
  dateTo: string;
}

// Module-level — статичні колонки (label = i18n labelKey, резолвиться у компоненті) +
// прекомпьютений JSON для hasCustomization.
const COLUMN_DEFS: Array<{ key: string; labelKey: string }> = [
  { key: 'number', labelKey: 'columns.number' },
  { key: 'type', labelKey: 'columns.type' },
  { key: 'warehouse', labelKey: 'columns.warehouse' },
  { key: 'status', labelKey: 'columns.status' },
  { key: 'lines', labelKey: 'columns.lines' },
  { key: 'date', labelKey: 'columns.date' },
  { key: 'linkedDocs', labelKey: 'columns.linkedDocs' },
];
const COLUMNS_DEFAULT_KEYS_JSON = JSON.stringify(COLUMN_DEFS.map(c => c.key));

// ─── Пов'язані документи (badge column) ────────────────────
// Ключі секцій дзеркалять backend stock-documents.getLinkedCounts (purchaseOrder/warehouses).
type LinkedCountsEntry = { purchaseOrder: number; warehouses: number };
type LinkedCountsField = keyof LinkedCountsEntry;
type LinkedCountsMap = Record<string, LinkedCountsEntry>;

// Stable empty fallback — module-level frozen reference avoids fresh {} per render.
const EMPTY_LINKED_COUNTS: LinkedCountsMap = Object.freeze({});

const DOC_COUNTERS: Array<{ field: LinkedCountsField; Icon: ElementType; labelKey: string }> = [
  { field: 'purchaseOrder', Icon: ClipboardList, labelKey: 'counters.purchaseOrder' },
  { field: 'warehouses', Icon: Warehouse, labelKey: 'counters.warehouses' },
];

// Filter tab arrays derived from shared constants — single source of truth.
// Adding a new type to STOCK_DOC_TYPE_LABELS automatically appears as a tab.
const TYPE_FILTERS: readonly string[] = Object.freeze(['', ...Object.keys(STOCK_DOC_TYPE_LABELS)]);
const STATUS_FILTERS: readonly string[] = Object.freeze([
  '',
  ...Object.keys(STOCK_DOC_STATUS_LABELS),
]);
// Module-level Set for O(1) lookup of valid URL `?type=` values (avoids re-allocating
// `Object.keys()` array on every render in `typeFromUrl` validation below).
const VALID_TYPES: ReadonlySet<string> = new Set(Object.keys(STOCK_DOC_TYPE_LABELS));

function StockDocumentsPageClient() {
  const { t } = useTranslation('stockDocuments');
  const { confirm, dialogProps } = useConfirm();

  // Колонки з i18n-мітками — резолвляться у компоненті (labelKey → t), memo по `t`.
  const COLUMNS = useMemo(() => COLUMN_DEFS.map(c => ({ ...c, label: t(c.labelKey) })), [t]);

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
      reorder,
      renameColumn,
      resetConfig,
    },
    dragProps,
    savedFilters: { saved: savedFilters, save: saveFilter, remove: removeFilter },
    features,
    limit,
  } = useListPage<StockDocFilters>('stock-documents', COLUMNS, { defaultLimit: 20 });

  // Local filter state (specific to stock-documents)
  const searchParams = useSearchParams();
  const router = useRouter();
  const typeFromUrl = searchParams.get('type') ?? '';
  const typeFilter = VALID_TYPES.has(typeFromUrl) ? typeFromUrl : '';
  const setTypeFilter = useCallback(
    (t: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (t) params.set('type', t);
      else params.delete('type');
      // scroll: false — keep current scroll position (otherwise switching tabs scrolls
      // page-fill container to top, which is jarring in long lists).
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState(() => kyivToday());
  const [dateTo, setDateTo] = useState(() => kyivToday());
  const { sort: sdSort, toggle: toggleSdSort } = useSortState('createdAt', 'desc');

  const qc = useQueryClient();
  const { data: docsData, isLoading: loading } = useStockDocuments({
    page,
    limit,
    type: typeFilter || undefined,
    status: statusFilter || undefined,
    showDeleted,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    sortBy: sdSort.sortBy,
    sortDir: sdSort.sortDir,
  });
  // regression guard — stable empty array reference.
  const docs = docsData?.items ?? (EMPTY_ITEMS as unknown as StockDoc[]);
  const total = docsData?.total ?? 0;

  // Пов'язані документи — nav + config + popup state + batched counts.
  const linkedNav = useLinkedNav();
  const linkedConfig = useMemo(() => stockDocumentLinkedConfig(linkedNav), [linkedNav]);
  const [linkedDocPopupId, setLinkedDocPopupId] = useState<string | null>(null);

  // Stable sorted ID list — prevents useQuery from refiring when React Query returns a
  // new array reference for identical data (e.g. background refetch with no changes).
  const docIds = useMemo(() => docs.map(d => d.id).sort(), [docs]);

  const { data: linkedCounts = EMPTY_LINKED_COUNTS } = useQuery<LinkedCountsMap>({
    queryKey: [...stockDocsKeys.all, 'linked-counts', docIds],
    queryFn: () =>
      apiFetch<LinkedCountsMap>('/stock-documents/linked-counts', {
        method: 'POST',
        body: JSON.stringify({ ids: docIds }),
      }),
    enabled: docIds.length > 0,
    staleTime: 30_000,
  });

  // WEB-H2: підтвердження/скасування складського документа рухає залишки → інвалідувати й
  // інвентар/звіти/дашборд, не лише список документів (інакше вкладка «Залишки» застаріла).
  const invalidate = () => invalidateStockDocumentSideEffects(qc);
  // оголошуємо `load` поряд з invalidate, щоб handleBulkDelete/handleTransition/markDeleted
  // що його використовують посилались на вже визначену константу (а не на TDZ-trap при copy-paste у refactor).
  const load = invalidate;
  const [error, setError] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [editingDocId, setEditingDocId] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState<StockDoc | null>(null);

  // Deep-link `?open=<docId>` — відкриває edit-modal конкретного складського документа
  // (напр. з панелі «пов'язані документи» іншого документа). Читаємо ОДНОРАЗОВО на mount,
  // валідуємо UUID, чистимо param щоб refresh не спамив модалку. Дзеркалить PO (Bug #596).
  useEffect(() => {
    const openId = searchParams.get('open');
    if (openId && UUID_RE.test(openId)) {
      setEditingDocId(openId);
      const params = new URLSearchParams(searchParams.toString());
      params.delete('open');
      router.replace(params.toString() ? `?${params.toString()}` : '?', { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open the standalone detail Modal (FSM buttons, full table).
  // List endpoint omits `lines` (perf: -20K line rows per page) — fetch full doc
  // via GET /stock-documents/:id and upgrade once it arrives.
  const openDetailModal = useCallback(async (doc: StockDoc) => {
    setShowDetail(doc);
    try {
      const detail = await apiFetch<StockDoc>(`/stock-documents/${doc.id}`);
      setShowDetail(prev => (prev?.id === doc.id ? detail : prev));
    } catch {
      // keep basic doc data if detail fetch fails — table renders empty body
    }
  }, []);

  const [saving, setSaving] = useState(false);

  const applyFilter = useCallback(
    (preset: { id: string; filters: StockDocFilters }) => {
      setTypeFilter(preset.filters.typeFilter ?? '');
      setStatusFilter(preset.filters.statusFilter ?? '');
      setShowDeleted(preset.filters.showDeleted ?? false);
      setDateFrom(preset.filters.dateFrom ?? '');
      setDateTo(preset.filters.dateTo ?? '');
      resetPage();
      setActiveSavedFilterId(preset.id);
    },
    [setTypeFilter, setShowDeleted, resetPage, setActiveSavedFilterId],
  );

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = saveFilter(name, { typeFilter, statusFilter, showDeleted, dateFrom, dateTo });
      setActiveSavedFilterId(preset.id);
      if (features.toastEnabled) toast.success(t('filters.filterSaved', { name }));
    },
    [
      saveFilter,
      typeFilter,
      statusFilter,
      showDeleted,
      dateFrom,
      dateTo,
      features.toastEnabled,
      setActiveSavedFilterId,
      t,
    ],
  );

  const { selectAllRef, ...bulkSelect } = useBulkIndeterminate(docs);

  // `load` is intentionally omitted from deps — it's recreated each render
  // but its input (filters from page state) is captured at click time via
  // closure. Including it would invalidate the callback on every keystroke.
  const handleBulkDelete = useCallback(
    async (ids: string[]) => {
      if (
        !(await confirm({
          title: t('confirm.bulkDeleteTitle', { count: ids.length }),
          confirmLabel: t('confirm.bulkDeleteConfirm'),
          variant: 'destructive',
        }))
      )
        return;
      const results = await Promise.allSettled(
        ids.map(id => apiFetch(`/stock-documents/${id}`, { method: 'DELETE' })),
      );
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.length - succeeded;
      bulkSelect.clear();
      load();
      if (features.toastEnabled) {
        if (succeeded > 0 && failed === 0) {
          toast.success(t('toast.bulkDeletedAll', { count: succeeded }));
        } else if (succeeded > 0 && failed > 0) {
          toast.warning(
            t('toast.bulkDeletedPartial', { succeeded, total: results.length, failed }),
          );
        } else {
          toast.error(t('toast.bulkDeleteNone'));
        }
      } else if (failed > 0) {
        setError(t('errors.bulkDeletePartial', { succeeded, total: results.length, failed }));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bulkSelect, confirm, features.toastEnabled, t],
  );

  const bulkActions = useMemo<BulkAction[]>(
    () => [
      {
        id: 'delete',
        label: t('actions.bulkDelete'),
        variant: 'destructive',
        icon: <Trash2 className="h-3.5 w-3.5 mr-1.5" />,
        // BulkAction.onClick типізований void-returning; handleBulkDelete не має шляху,
        // що реджектиться — `confirm()` ніколи не реджектиться, `Promise.allSettled`
        // поглинає відмови кожного DELETE і звітує через toast/`setError`.
        onClick: ids => void handleBulkDelete(ids),
      },
    ],
    [handleBulkDelete, t],
  );

  const totalPages = Math.ceil(total / limit) || 1;

  // sto-optimize: stable refs — handlers used у inline row onClick wrappers; useCallback
  // дозволяє в майбутньому пройти React.memo на TableRow без identity-thrashing.
  // `load` ref recreates on each invalidation, але семантика та сама — deps eslint-disable.
  // `void` перед `handleTransition()` / `handleBulkDelete()` у JSX: обидва мають власний
  // try/catch (або Promise.allSettled), що показує текст відмови користувачу — у `error`
  // (баннер над таблицею) та/або `toast`, плюс `finally { setSaving(false) }`. Відмова вже
  // на екрані, тож чекати проміс обробника нікому не потрібно.
  const handleTransition = useCallback(
    // newStatus був `string` — у кеш/тіло запиту міг піти будь-який рядок.
    async (doc: StockDoc, newStatus: StockDocStatusValue) => {
      const action =
        newStatus === 'CONFIRMED' ? t('confirm.transitionConfirm') : t('confirm.transitionCancel');
      if (!(await confirm({ title: t('confirm.transition', { action, number: doc.number }) })))
        return;
      setSaving(true);
      setError('');
      try {
        await apiFetch<StockDoc>(`/stock-documents/${doc.id}/transition`, {
          method: 'POST',
          body: JSON.stringify({ status: newStatus }),
        });
        setShowDetail(null);
        load();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : t('errors.transitionFailed'));
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [confirm, t],
  );

  const markDeleted = useCallback(
    async (doc: StockDoc) => {
      if (
        !(await confirm({
          title: t('confirm.markForDeletion', { number: doc.number }),
          variant: 'destructive',
        }))
      )
        return;
      try {
        await apiFetch(`/stock-documents/${doc.id}`, { method: 'DELETE' });
        load();
        toast.success(t('toast.markedForDeletion'));
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : t('errors.deleteFailed'));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [confirm, t],
  );

  return (
    <>
      {error && (
        <div className="mb-4 text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}

      {/* Saved filters */}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<StockDocFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          hideSaveButton
        />
      )}

      {/* Type tabs (+ «Рухи» праворуч) */}
      <StockTypeTabs
        activeType={typeFilter}
        movementsActive={false}
        onSelectType={t2 => {
          setTypeFilter(t2);
          resetPage();
          setActiveSavedFilterId(null);
        }}
        onSelectMovements={() =>
          router.replace('/stock-documents?tab=movements', { scroll: false })
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 shrink-0">
        {/* Status filters */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide mr-1">
            {t('filters.status')}
          </span>
          {STATUS_FILTERS.map(s => (
            <StatusPill
              key={s}
              value={s}
              label={s ? stockDocStatusLabel(s) : t('filters.all')}
              active={statusFilter === s}
              description={s ? STOCK_DOC_STATUS_DESCRIPTIONS[s] : undefined}
              onSelect={v => {
                setStatusFilter(v);
                resetPage();
                setActiveSavedFilterId(null);
              }}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-muted-foreground shrink-0">
            {t('filters.dateFrom')}
          </span>
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
          <span className="text-[13px] text-muted-foreground shrink-0">{t('filters.dateTo')}</span>
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
            title={showDeleted ? t('filters.hideDeleted') : t('filters.showDeleted')}
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
          {/* Bug #505: DetailPanelToggle видалено — toggle нічого не контролював (DetailPanel мертвий, Bug #504). */}
          <Button onClick={() => setShowCreate(true)} leftIcon={<Plus className="h-4 w-4" />}>
            {typeFilter ? stockDocTypeLabel(typeFilter) : t('actions.addDocument')}
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
                      aria-label={t('aria.selectAll')}
                    />
                  </TableHead>
                )}
                {visibleColumns.map(col => {
                  const sortable = ['date'].includes(col.key);
                  if (sortable)
                    return (
                      <SortableHead
                        key={col.key}
                        sortKey="documentDate"
                        currentSort={sdSort}
                        onSort={toggleSdSort}
                        {...dragProps(col.key)}
                      >
                        {col.label}
                      </SortableHead>
                    );
                  return (
                    <TableHead
                      key={col.key}
                      className={col.key === 'lines' ? 'text-right' : undefined}
                      {...dragProps(col.key)}
                    >
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
              {!loading && docs.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)}
                    className="p-0"
                  >
                    <EmptyState icon={FileText} title={t('empty.documentsNotFound')} />
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                docs.map(doc => (
                  <TableRow
                    key={doc.id}
                    className={cn(
                      'group transition-colors cursor-pointer',
                      bulkSelect.isSelected(doc.id) && 'bg-primary/5',
                      doc.deletedAt && 'opacity-60',
                    )}
                    onClick={() => {
                      setEditingDocId(doc.id);
                    }}
                  >
                    {features.bulkActionsEnabled && (
                      <TableCell className="w-9 pr-0" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={bulkSelect.isSelected(doc.id)}
                          onChange={() => bulkSelect.toggle(doc.id)}
                          className="h-3.5 w-3.5 rounded border-border"
                          aria-label={t('aria.selectRow', { number: doc.number })}
                        />
                      </TableCell>
                    )}
                    {visibleColumns.map(col => {
                      if (col.key === 'number')
                        return (
                          <TableCell key="number" className="font-medium text-[13px]">
                            {doc.number}
                            {doc.deletedAt && (
                              <Badge variant="destructive" className="ml-2 text-[10px] px-1 py-0">
                                {t('badges.deleted')}
                              </Badge>
                            )}
                          </TableCell>
                        );
                      if (col.key === 'type')
                        return (
                          <TableCell key="type">
                            <Badge
                              variant={STOCK_DOC_TYPE_BADGE[doc.type] ?? 'secondary'}
                              tooltip={STOCK_DOC_TYPE_DESCRIPTIONS[doc.type]}
                            >
                              {stockDocTypeLabel(doc.type)}
                            </Badge>
                          </TableCell>
                        );
                      if (col.key === 'warehouse')
                        return (
                          <TableCell key="warehouse" className="text-[13px] text-muted-foreground">
                            {doc.warehouseName ?? '—'}
                          </TableCell>
                        );
                      if (col.key === 'status')
                        return (
                          <TableCell key="status">
                            <Badge
                              variant={STOCK_DOC_STATUS_BADGE[doc.status] ?? 'secondary'}
                              tooltip={STOCK_DOC_STATUS_DESCRIPTIONS[doc.status]}
                            >
                              {stockDocStatusLabel(doc.status)}
                            </Badge>
                          </TableCell>
                        );
                      if (col.key === 'lines')
                        return (
                          <TableCell
                            key="lines"
                            className="text-right text-[13px] text-muted-foreground"
                          >
                            {doc.linesCount ?? doc.lines?.length ?? 0}
                          </TableCell>
                        );
                      if (col.key === 'date')
                        return (
                          <TableCell key="date" className="text-[13px] text-muted-foreground">
                            {doc.documentDate ? fmtDate(doc.documentDate) : fmtDate(doc.createdAt)}
                          </TableCell>
                        );
                      if (col.key === 'linkedDocs') {
                        const counts = linkedCounts[doc.id];
                        return (
                          <TableCell key="linkedDocs" onClick={e => e.stopPropagation()}>
                            <div className="flex gap-1.5 items-center text-xs text-muted-foreground">
                              {DOC_COUNTERS.map(({ field, Icon, labelKey }) => {
                                const n = counts?.[field];
                                if (!n) return null;
                                return (
                                  <button
                                    key={field}
                                    onClick={() => setLinkedDocPopupId(doc.id)}
                                    className="flex items-center gap-0.5 hover:text-foreground transition-colors"
                                    title={`${t(labelKey)}: ${n}`}
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
                          title={t('actions.openDetails')}
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => void openDetailModal(doc)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        {!doc.deletedAt && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={t('actions.markForDeletion')}
                            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                            onClick={() => void markDeleted(doc)}
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

        {/* Bug #504: DetailPanel видалено — selectedDoc state ніколи не set non-null (Bug #496 paired-file pattern). */}
      </div>

      {/* Pagination */}
      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      {/* Create modal */}
      <StockDocumentCreateModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSaved={() => {
          setShowCreate(false);
          load();
        }}
      />

      {/* Edit modal */}
      <StockDocumentCreateModal
        open={!!editingDocId}
        stockDocumentId={editingDocId ?? undefined}
        onClose={() => setEditingDocId(null)}
        onSaved={() => {
          invalidate();
        }}
      />

      {/* Detail modal */}
      <Modal
        open={!!showDetail}
        onClose={() => setShowDetail(null)}
        title={showDetail ? `${stockDocTypeLabel(showDetail.type)} ${showDetail.number}` : ''}
        size="lg"
        footer={
          showDetail?.status === 'DRAFT' ? (
            <div className="flex gap-2 w-full">
              <Button
                onClick={() => void handleTransition(showDetail, 'CONFIRMED')}
                loading={saving}
                className="flex-1"
              >
                {t('detail.confirmButton')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handleTransition(showDetail, 'CANCELLED')}
                loading={saving}
              >
                {t('detail.cancelButton')}
              </Button>
            </div>
          ) : undefined
        }
      >
        {showDetail && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Badge
                variant={STOCK_DOC_TYPE_BADGE[showDetail.type] ?? 'secondary'}
                tooltip={STOCK_DOC_TYPE_DESCRIPTIONS[showDetail.type]}
              >
                {stockDocTypeLabel(showDetail.type)}
              </Badge>
              <Badge
                variant={STOCK_DOC_STATUS_BADGE[showDetail.status] ?? 'secondary'}
                tooltip={STOCK_DOC_STATUS_DESCRIPTIONS[showDetail.status]}
              >
                {stockDocStatusLabel(showDetail.status)}
              </Badge>
              <span className="text-muted-foreground text-sm">{showDetail.warehouseName}</span>
              {showDetail.targetWarehouseName && (
                <span className="text-foreground-faint text-sm">
                  → {showDetail.targetWarehouseName}
                </span>
              )}
            </div>

            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-secondary">
                  <tr>
                    <th className="text-left px-3 py-2 text-muted-foreground">
                      {t('detail.colGood')}
                    </th>
                    <th className="text-left px-3 py-2 text-muted-foreground">
                      {t('detail.colSku')}
                    </th>
                    <th className="text-right px-3 py-2 text-muted-foreground">
                      {t('detail.colQuantity')}
                    </th>
                    <th className="text-right px-3 py-2 text-muted-foreground">
                      {t('detail.colPrice')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {showDetail.lines === undefined ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-2 text-center text-muted-foreground">
                        {t('detail.loading')}
                      </td>
                    </tr>
                  ) : (
                    showDetail.lines.map((l, i) => (
                      <tr key={l.id ?? i}>
                        <td className="px-3 py-2 text-foreground">{l.goodName}</td>
                        <td className="px-3 py-2 text-foreground-faint font-mono">
                          {l.goodSku ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-medium">
                          {l.quantity} {l.unitShortName ?? l.unit}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {l.price != null ? `${fmtMoney(l.price)} ₴` : '—'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {showDetail.notes && (
              <p className="text-sm text-muted-foreground italic">{showDetail.notes}</p>
            )}

            {showDetail.confirmedAt && (
              <p className="text-xs text-foreground-faint">
                {t('detail.confirmedAt', { date: fmtDateTime(showDetail.confirmedAt) })}
              </p>
            )}

            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                {t('detail.linkedDocuments')}
              </h3>
              <LinkedDocumentsPanel config={linkedConfig} entityId={showDetail.id} />
            </div>
          </div>
        )}
      </Modal>
      <ConfirmDialog {...dialogProps} />

      {linkedDocPopupId && (
        <LinkedDocumentsPopup
          entityId={linkedDocPopupId}
          config={linkedConfig}
          onClose={() => setLinkedDocPopupId(null)}
          ariaLabel={t('aria.linkedDocsPopup')}
        />
      )}
    </>
  );
}

const TAB_CLASS =
  'flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:rounded-sm';
const TAB_ACTIVE = 'border-primary text-primary';
const TAB_IDLE =
  'border-transparent text-muted-foreground hover:text-foreground hover:border-border';

/**
 * Рядок вкладок сторінки «Склад»: типи документів (з `STOCK_DOC_TYPE_LABELS`, BR-SDOC-007) і
 * праворуч — «Рухи». Окремої верхньої смуги «Документи складу / Залишки / Рухи» більше немає:
 * «Залишки» переїхали у «Звіти» (`/reports?tab=inventory`), а «Рухи» стали вкладкою тут.
 */
function StockTypeTabs({
  activeType,
  movementsActive,
  onSelectType,
  onSelectMovements,
}: {
  /** Активний тип документа; '' — «Всі». Ігнорується, коли відкрито «Рухи». */
  activeType: string;
  movementsActive: boolean;
  onSelectType: (type: string) => void;
  onSelectMovements: () => void;
}) {
  const { t } = useTranslation('stockDocuments');
  return (
    <div className="shrink-0 flex gap-0 border-b border-border -mx-6 px-6 overflow-x-auto">
      {TYPE_FILTERS.map(t2 => (
        <button
          key={t2}
          type="button"
          onClick={() => onSelectType(t2)}
          className={cn(TAB_CLASS, !movementsActive && activeType === t2 ? TAB_ACTIVE : TAB_IDLE)}
        >
          {t2 ? stockDocTypeLabel(t2) : t('filters.all')}
        </button>
      ))}
      <button
        type="button"
        onClick={onSelectMovements}
        aria-current={movementsActive ? 'page' : undefined}
        className={cn(TAB_CLASS, 'ml-auto', movementsActive ? TAB_ACTIVE : TAB_IDLE)}
      >
        {t('tabs.movements')}
      </button>
    </div>
  );
}

// Сторінка «Склад»: документи складу + «Рухи». Ціни й собівартість → лише ролі документів
// (backend @Roles на /stock-documents і рухах); приймальник сюди більше не заходить — його
// «Залишки» тепер у «Звітах».
function StockPageShell() {
  const { t } = useTranslation('stockDocuments');
  useRequireAuth(['OWNER', 'ADMIN', 'STOREKEEPER']);
  const router = useRouter();
  const searchParams = useSearchParams();
  const showMovements = searchParams.get('tab') === 'movements';

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('title')}</h1>
        </div>
      </div>

      {showMovements ? (
        <>
          <StockTypeTabs
            activeType=""
            movementsActive
            onSelectType={type =>
              router.replace(type ? `/stock-documents?type=${type}` : '/stock-documents', {
                scroll: false,
              })
            }
            onSelectMovements={() => undefined}
          />
          <StockMovementsTab />
        </>
      ) : (
        <StockDocumentsPageClient />
      )}
    </div>
  );
}

// Старі посилання й закладки на вкладку «Залишки» (`?tab=stock`) ведуть у «Звіти». Редирект
// стоїть ДО рольового guard-а сторінки: приймальник не має доступу до «Складу», але має до
// залишків, і guard відправив би його геть раніше за редирект.
function StockDocumentsRoute() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const legacyStockTab = searchParams.get('tab') === 'stock';
  useEffect(() => {
    if (legacyStockTab) router.replace('/reports?tab=inventory');
  }, [legacyStockTab, router]);
  if (legacyStockTab) return null;
  return <StockPageShell />;
}

export default function StockDocumentsPage() {
  return (
    <Suspense fallback={null}>
      <StockDocumentsRoute />
    </Suspense>
  );
}
