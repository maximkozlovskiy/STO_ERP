'use client';

import { Suspense, useState, useCallback, useMemo, useEffect } from 'react';
import type { ElementType } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams, useRouter } from 'next/navigation';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useStockDocuments, stockDocsKeys, type StockDoc } from '@/hooks/api/useStockDocuments';
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
import { activateRow } from '@/lib/row-activation';
import { LinkedDocumentsPopup } from '@/components/ui/LinkedDocumentsPopup';
import { LinesSummarySection } from '@/components/ui/LinesSummarySection';
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
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pagination } from '@/components/ui/pagination';
import { useConfirm } from '@/hooks/useConfirm';
import { DateRangeFilter } from '@/components/ui/date-range-filter';
import { ListSearchInput } from '@/components/ui/list-search-input';
import { StockDocumentCreateModal } from '@/components/ui/StockDocumentCreateModal';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState, ListEmptyState } from '@/components/ui/empty-state';
// Клік по рядку: бокова панель увімкнена → рядок вибирається в панель; вимкнена → одразу
// картка редагування (setEditingDocId). Стандарт списків — як у закупівель.
import { DetailPanel, PanelField } from '@/components/ui/detail-panel';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import {
  STOCK_DOC_PANEL_SCHEMA,
  buildPanelFields,
  schemaToPanelConfigFields,
} from '@/lib/panel-schema';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  SortableHead,
  TableCell,
  DocLink,
} from '@/components/ui/table';
import { useUrlCard } from '@/lib/url-card';
import { useSortState } from '@/hooks/useSortState';
import { useDebounce } from '@/hooks/useDebounce';
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { useListPage } from '@/hooks/useListPage';
import { useBulkIndeterminate } from '@/hooks/useBulkIndeterminate';
import { toast } from '@/lib/toast';
import { invalidateStockDocumentSideEffects } from '@/lib/cache-invalidation';
import { cn } from '@/lib/utils';
import { PAGE_TAB_ACTIVE, PAGE_TAB_CLASS, PAGE_TAB_IDLE } from '@/lib/page-tabs';
import { fmtDate, kyivToday } from '@/lib/format';
import { StatusPill } from '@/components/ui/status-pill';
import { ListFiltersRow, ListStatusRow } from '@/components/ui/list-toolbar';

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
  // Опційне: пресети, збережені до появи пошуку, цього поля не мають.
  search?: string;
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
    detailPanel,
    panelConfig,
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
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const { sort: sdSort, toggle: toggleSdSort } = useSortState('createdAt', 'desc');

  const qc = useQueryClient();
  const { data: docsData, isLoading: loading } = useStockDocuments({
    page,
    limit,
    type: typeFilter || undefined,
    status: statusFilter || undefined,
    showDeleted,
    q: debouncedSearch.trim() || undefined,
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
  // Картка документа — в адресі (`?open=<id>`): посилання відкриває її, «Назад» закриває.
  const card = useUrlCard();
  const editingDocId = card.id;
  const { open: openCard, close: closeCard } = card;
  const setEditingDocId = useCallback(
    (id: string | null) => (id ? openCard(id) : closeCard()),
    [openCard, closeCard],
  );

  // Бокова панель. Зберігаємо лише id: рядок беремо зі свіжого списку, тож після
  // збереження / проведення документа панель не показує застарілу шапку, а рядок, що зник зі
  // списку (інша вкладка-тип, фільтр, видалення), закриває панель сам.
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const selectedDoc = useMemo(
    () => (selectedDocId ? (docs.find(d => d.id === selectedDocId) ?? null) : null),
    [docs, selectedDocId],
  );
  // Вимкнули панель → скидаємо вибір (той самий Bug #624, що в закупівель): інакше після
  // повторного вмикання клік по тому самому рядку закрив би панель замість відкрити.
  useEffect(() => {
    if (!detailPanel.enabled) setSelectedDocId(null);
  }, [detailPanel.enabled]);
  // Рядок зник із завантаженого списку (інша сторінка, фільтр, вкладка-тип, видалення) → вибір
  // забуваємо. Інакше id лишається «прихованим»: повернувся на ту саму сторінку чи зняв фільтр —
  // і панель відкривається сама, без кліку.
  useEffect(() => {
    if (selectedDocId && !loading && !selectedDoc) setSelectedDocId(null);
  }, [selectedDocId, selectedDoc, loading]);

  const panelConfigFields = useMemo(
    () => schemaToPanelConfigFields(STOCK_DOC_PANEL_SCHEMA, panelConfig.config),
    [panelConfig.config],
  );

  const changeFilter = (fn: () => void) => {
    fn();
    resetPage();
    setActiveSavedFilterId(null);
  };

  const applyFilter = useCallback(
    (preset: { id: string; filters: StockDocFilters }) => {
      setTypeFilter(preset.filters.typeFilter ?? '');
      setStatusFilter(preset.filters.statusFilter ?? '');
      setShowDeleted(preset.filters.showDeleted ?? false);
      setDateFrom(preset.filters.dateFrom ?? '');
      setDateTo(preset.filters.dateTo ?? '');
      setSearch(preset.filters.search ?? '');
      resetPage();
      setActiveSavedFilterId(preset.id);
    },
    [setTypeFilter, setShowDeleted, resetPage, setActiveSavedFilterId],
  );

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = saveFilter(name, {
        typeFilter,
        statusFilter,
        showDeleted,
        dateFrom,
        dateTo,
        search,
      });
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
      search,
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

      {/* Type tabs (+ «Рухи» праворуч) */}
      <StockTypeTabs
        activeType={typeFilter}
        movementsActive={false}
        onSelectType={t2 => changeFilter(() => setTypeFilter(t2))}
        onSelectMovements={() =>
          router.replace('/stock-documents?tab=movements', { scroll: false })
        }
      />

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

      {/* Status filters */}
      <ListStatusRow label={t('filters.status')}>
        {STATUS_FILTERS.map(s => (
          <StatusPill
            key={s}
            value={s}
            label={s ? stockDocStatusLabel(s) : t('filters.all')}
            active={statusFilter === s}
            description={s ? STOCK_DOC_STATUS_DESCRIPTIONS[s] : undefined}
            onSelect={v => changeFilter(() => setStatusFilter(v))}
          />
        ))}
      </ListStatusRow>

      {/* Filters */}
      <ListFiltersRow
        actions={
          <>
            <Button
              variant="outline"
              size="icon-sm"
              title={showDeleted ? t('filters.hideDeleted') : t('filters.showDeleted')}
              onClick={() => changeFilter(() => setShowDeleted(v => !v))}
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
            <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
            <Button onClick={() => setShowCreate(true)} leftIcon={<Plus className="h-4 w-4" />}>
              {typeFilter ? stockDocTypeLabel(typeFilter) : t('actions.addDocument')}
            </Button>
          </>
        }
      >
        <ListSearchInput
          value={search}
          onChange={v => changeFilter(() => setSearch(v))}
          label={t('filters.searchPlaceholder')}
        />
        <DateRangeFilter
          from={dateFrom}
          to={dateTo}
          onFromChange={v => changeFilter(() => setDateFrom(v))}
          onToChange={v => changeFilter(() => setDateTo(v))}
          fromLabel={t('filters.dateFrom')}
          toLabel={t('filters.dateTo')}
        />
      </ListFiltersRow>

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
                    <ListEmptyState
                      icon={FileText}
                      title={t('empty.documentsNotFound')}
                      // Тип документа — вкладка, а не фільтр: її скидання не чіпає.
                      filtered={!!(statusFilter || search || dateFrom || dateTo)}
                      onResetFilters={() => {
                        setStatusFilter('');
                        setSearch('');
                        setDateFrom('');
                        setDateTo('');
                        resetPage();
                        setActiveSavedFilterId(null);
                      }}
                    />
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                docs.map(doc => (
                  <TableRow
                    key={doc.id}
                    className={cn(
                      'group transition-colors cursor-pointer',
                      selectedDoc?.id === doc.id && detailPanel.enabled && 'bg-primary/5',
                      bulkSelect.isSelected(doc.id) && 'bg-primary/5',
                      doc.deletedAt && 'opacity-60',
                    )}
                    onClick={() =>
                      activateRow({
                        panelEnabled: detailPanel.enabled,
                        isSelected: selectedDocId === doc.id,
                        select: () => setSelectedDocId(doc.id),
                        deselect: () => setSelectedDocId(null),
                        open: () => setEditingDocId(doc.id),
                      })
                    }
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
                          <TableCell key="number" className="whitespace-nowrap">
                            <DocLink
                              href={card.hrefFor(doc.id)}
                              onOpen={() => setEditingDocId(doc.id)}
                            >
                              {doc.number}
                            </DocLink>
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
                          title={t('actions.openDocument')}
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => setEditingDocId(doc.id)}
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

        <DetailPanel
          open={!!selectedDoc && detailPanel.enabled}
          onClose={() => setSelectedDocId(null)}
          title={selectedDoc?.number ?? ''}
          subtitle={selectedDoc ? stockDocTypeLabel(selectedDoc.type) : undefined}
          configFields={panelConfigFields}
          onToggleField={panelConfig.toggleField}
          onReorderFields={panelConfig.reorderFields}
          onReset={panelConfig.reset}
        >
          {selectedDoc && (
            <div className="space-y-3">
              {buildPanelFields(selectedDoc, STOCK_DOC_PANEL_SCHEMA, panelConfig.config, {
                type: () => (
                  <Badge
                    variant={STOCK_DOC_TYPE_BADGE[selectedDoc.type] ?? 'secondary'}
                    tooltip={STOCK_DOC_TYPE_DESCRIPTIONS[selectedDoc.type]}
                  >
                    {stockDocTypeLabel(selectedDoc.type)}
                  </Badge>
                ),
                status: () => (
                  <Badge
                    variant={STOCK_DOC_STATUS_BADGE[selectedDoc.status] ?? 'secondary'}
                    tooltip={STOCK_DOC_STATUS_DESCRIPTIONS[selectedDoc.status]}
                  >
                    {stockDocStatusLabel(selectedDoc.status)}
                  </Badge>
                ),
              }).map(f => (
                <PanelField
                  key={f.key}
                  fieldKey={f.key}
                  label={f.label}
                  value={f.value}
                  hidden={f.hidden}
                />
              ))}
              <LinesSummarySection
                entity="stock-documents"
                id={selectedDoc.id}
                enabled={detailPanel.enabled}
              />
              <div className="pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => setEditingDocId(selectedDoc.id)}
                >
                  {t('panel.openDocument')}
                </Button>
              </div>
            </div>
          )}
        </DetailPanel>
      </div>

      {/* Pagination */}
      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      {/* Create modal */}
      <StockDocumentCreateModal
        open={showCreate}
        defaultType={typeFilter || undefined}
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
          className={cn(
            PAGE_TAB_CLASS,
            !movementsActive && activeType === t2 ? PAGE_TAB_ACTIVE : PAGE_TAB_IDLE,
          )}
        >
          {t2 ? stockDocTypeLabel(t2) : t('filters.all')}
        </button>
      ))}
      <button
        type="button"
        onClick={onSelectMovements}
        aria-current={movementsActive ? 'page' : undefined}
        className={cn(PAGE_TAB_CLASS, 'ml-auto', movementsActive ? PAGE_TAB_ACTIVE : PAGE_TAB_IDLE)}
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
